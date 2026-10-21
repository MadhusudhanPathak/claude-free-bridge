import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeFailure } from '../../shared/src/errors';
import {
  CloseCode,
  type ExtensionStatus,
  type ExtensionToHelper,
  type HelperToExtension,
  type Op,
  type OpMap,
  PROTOCOL_VERSION,
} from '../../shared/src/protocol';
import { log } from './logger';
import { safeEqual } from './security';

interface CallOptions {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: BridgeFailure) => void;
  onChunk?: (text: string) => void;
}

type Hello = Extract<ExtensionToHelper, { type: 'hello' }>;

const HELLO_TIMEOUT_MS = 5000;
const IDLE_LIMIT_MS = 70_000; // the extension pings every 20 s
const ALIVE_CHECK_MS = 2000;
const MAX_BAD_TOKENS = 10;
const EXTENSION_ORIGIN = /^(chrome-extension|extension):\/\/[a-z0-9]+\/?$/i;

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Parses a frame from the extension. Returns null for anything that isn't a JSON object with a type. */
function parseFrame(raw: string): ExtensionToHelper | null {
  try {
    const msg: unknown = JSON.parse(raw);
    return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string' ? (msg as ExtensionToHelper) : null;
  } catch {
    return null;
  }
}

function isStatus(s: unknown): s is ExtensionStatus {
  const v = s as Partial<ExtensionStatus> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.loggedIn === 'boolean' &&
    typeof v.settings === 'object' &&
    v.settings !== null &&
    Array.isArray(v.settings.models)
  );
}

function isValidHello(h: Hello): boolean {
  return typeof h.instanceId === 'string' && typeof h.version === 'string' && typeof h.browser === 'string' && isStatus(h.status);
}

/**
 * The app's end of the WebSocket the browser extension connects to. Exactly one extension
 * connection is active at a time. Emits 'connected', 'disconnected' and 'status'.
 */
export class ExtensionLink extends EventEmitter {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private socket: WebSocket | null = null;
  private instanceId: string | null = null;
  private pending = new Map<string, Pending>();
  private badTokens = 0;
  private lastSeen = 0;
  private readonly watchdog: NodeJS.Timeout;

  browser = '';
  extensionVersion = '';
  status: ExtensionStatus | null = null;
  /** Last refused connection attempt (wrong pairing code), so the Control Center can explain it. */
  lastRejection: { at: number; reason: string } | null = null;

  constructor(private readonly opts: { pairingToken: string; helperVersion: string; path: string }) {
    super();
    this.setMaxListeners(0);
    this.watchdog = setInterval(() => {
      if (this.socket && Date.now() - this.lastSeen > IDLE_LIMIT_MS) {
        log.warn('Extension stopped responding; dropping its connection');
        this.socket.terminate();
      }
    }, 10_000);
    this.watchdog.unref();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Called from the HTTP server's 'upgrade' event. Returns false if the path isn't ours. */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url || '').split('?')[0];
    if (path !== this.opts.path) return false;

    const origin = String(req.headers.origin || '');
    if (!EXTENSION_ORIGIN.test(origin)) {
      log.warn(`Refused WebSocket from non-extension origin "${origin}"`);
      rejectUpgrade(socket, '403 Forbidden');
      return true;
    }
    if (this.badTokens >= MAX_BAD_TOKENS) {
      rejectUpgrade(socket, '403 Forbidden');
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    return true;
  }

  private onConnection(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(CloseCode.BadToken, 'No hello received'), HELLO_TIMEOUT_MS);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      this.onHello(ws, parseFrame(raw.toString())).catch((e) => {
        log.error('Extension handshake failed', e);
        ws.terminate();
      });
    });
  }

  private async onHello(ws: WebSocket, msg: ExtensionToHelper | null): Promise<void> {
    if (msg?.type !== 'hello') {
      ws.close(CloseCode.ProtocolMismatch, 'Expected hello');
      return;
    }
    if (typeof msg.token !== 'string' || !safeEqual(msg.token, this.opts.pairingToken)) {
      this.badTokens++;
      this.lastRejection = { at: Date.now(), reason: 'wrong-pairing-code' };
      log.warn(`Extension tried to connect with a wrong pairing code (${this.badTokens}/${MAX_BAD_TOKENS})`);
      if (this.badTokens >= MAX_BAD_TOKENS) {
        log.error('Too many wrong pairing codes; refusing extension connections until the app restarts');
        ws.close(CloseCode.TooManyAttempts, 'Too many wrong pairing codes. Restart the Claude Free Bridge app, then try again.');
      } else {
        ws.close(CloseCode.BadToken, 'Wrong pairing code. Copy it again from the Claude Free Bridge app.');
      }
      return;
    }
    this.badTokens = 0;
    if (msg.protocol !== PROTOCOL_VERSION || !isValidHello(msg)) {
      ws.close(
        CloseCode.ProtocolMismatch,
        'This extension and the Claude Free Bridge app are different versions. Load the extension folder that came with the app.'
      );
      return;
    }

    const old = this.socket;
    if (old && old.readyState === WebSocket.OPEN && this.instanceId !== msg.instanceId && (await this.isAlive(old))) {
      ws.close(CloseCode.Busy, `Another browser (${this.browser}) is already connected to the app.`);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (old) old.close(CloseCode.Replaced, 'Replaced by a newer connection');
    this.adopt(ws, msg);
  }

  private isAlive(ws: WebSocket): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ALIVE_CHECK_MS);
      ws.once('pong', () => {
        clearTimeout(t);
        resolve(true);
      });
      try {
        ws.ping();
      } catch {
        clearTimeout(t);
        resolve(false);
      }
    });
  }

  private adopt(ws: WebSocket, hello: Hello): void {
    this.socket = ws;
    this.lastRejection = null;
    this.instanceId = hello.instanceId;
    this.browser = hello.browser;
    this.extensionVersion = hello.version;
    this.status = hello.status;
    this.lastSeen = Date.now();

    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('pong', () => (this.lastSeen = Date.now()));
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = null;
      log.warn('Extension disconnected');
      for (const p of this.pending.values()) {
        p.reject(new BridgeFailure('EXTENSION_DISCONNECTED', 'The browser extension disconnected mid-request'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });

    this.send(ws, { type: 'welcome', helperVersion: this.opts.helperVersion });
    log.info(`Extension connected from ${hello.browser} (extension ${hello.version})`);
    this.emit('connected');
    this.emit('status', this.status);
  }

  private onMessage(raw: string): void {
    this.lastSeen = Date.now();
    const msg = parseFrame(raw);
    if (!msg) {
      log.warn('Ignoring malformed frame from extension');
      return;
    }
    switch (msg.type) {
      case 'ping':
        if (this.socket) this.send(this.socket, { type: 'pong' });
        break;
      case 'status':
        if (!isStatus(msg.status)) {
          log.warn('Ignoring malformed status from extension');
          break;
        }
        this.status = msg.status;
        this.emit('status', msg.status);
        break;
      case 'chunk':
        if (typeof msg.text === 'string') this.pending.get(msg.id)?.onChunk?.(msg.text);
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        if (msg.ok) p.resolve(msg.data);
        else p.reject(BridgeFailure.from(msg.error ?? { code: 'UPSTREAM_ERROR', message: 'The extension reported an unknown error' }));
        break;
      }
      default:
        log.debug('Unexpected frame from extension', msg);
    }
  }

  /** Switches to a new pairing code; a connected extension has to pair again with it. */
  setPairingToken(token: string): void {
    this.opts.pairingToken = token;
    this.badTokens = 0;
    this.socket?.close(CloseCode.BadToken, 'The pairing code was changed in the Claude Free Bridge app. Paste the new one.');
  }

  /** Marks the cached status as logged out (until the extension reports otherwise). */
  markLoggedOut(): void {
    if (this.status?.loggedIn) {
      this.status = { ...this.status, loggedIn: false };
      this.emit('status', this.status);
    }
  }

  /**
   * Resolves once `ready()` is true, re-checking whenever the extension connects or reports
   * status. Rejects with `failure` after `timeoutMs`, or with CANCELLED if `signal` aborts.
   */
  waitUntil(ready: () => boolean, timeoutMs: number, failure: BridgeFailure, signal?: AbortSignal): Promise<void> {
    if (ready()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new BridgeFailure('CANCELLED', 'Request cancelled by the client'));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.off('status', check);
        this.off('connected', check);
        signal?.removeEventListener('abort', onAbort);
      };
      const check = () => {
        if (!ready()) return;
        done();
        resolve();
      };
      const onAbort = () => {
        done();
        reject(new BridgeFailure('CANCELLED', 'Request cancelled by the client'));
      };
      const timer = setTimeout(() => {
        done();
        reject(failure);
      }, timeoutMs);
      this.on('status', check);
      this.on('connected', check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Runs `op` in the extension. Chunks stream to `onChunk`; abort or timeout sends `cancel`. */
  call<K extends Op>(op: K, params: OpMap[K]['params'], opts: CallOptions = {}): Promise<OpMap[K]['result']> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeFailure('EXTENSION_DISCONNECTED', 'The browser extension is not connected to the helper'));
    }
    const id = crypto.randomUUID();
    const { signal, timeoutMs, onChunk } = opts;

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const cancel = (failure: BridgeFailure) => {
        if (!this.pending.has(id)) return;
        if (this.socket === ws) this.send(ws, { type: 'cancel', id });
        finish();
        reject(failure);
      };
      const onAbort = () => cancel(new BridgeFailure('CANCELLED', 'Request cancelled by the client'));

      this.pending.set(id, {
        resolve: (v) => {
          finish();
          resolve(v as OpMap[K]['result']);
        },
        reject: (e) => {
          finish();
          reject(e);
        },
        onChunk,
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs) {
        timer = setTimeout(
          () => cancel(new BridgeFailure('TIMEOUT', `No complete reply from claude.ai within ${Math.round(timeoutMs / 1000)} s`)),
          timeoutMs
        );
      }
      this.send(ws, { type: 'request', id, op, params } as HelperToExtension);
    });
  }

  private send(ws: WebSocket, frame: HelperToExtension): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      log.warn('Failed to send to extension', e);
    }
  }

  close(): void {
    clearInterval(this.watchdog);
    this.socket?.terminate();
    this.wss.close();
  }
}

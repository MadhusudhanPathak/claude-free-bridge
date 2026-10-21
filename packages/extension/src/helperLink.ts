// The extension's end of the WebSocket to the local helper: pairing handshake, keepalive,
// reconnects, and dispatching helper requests to the job runner.
import { toBridgeError } from '../../shared/src/errors';
import {
  CloseCode,
  type ExtensionStatus,
  type ExtensionToHelper,
  type HelperToExtension,
  type Op,
  type OpMap,
  PROTOCOL_VERSION,
  type RequestFrame,
} from '../../shared/src/protocol';
import type { HelperState } from './messages';
import { getConnection, setConnection } from './store';

// WebSocket traffic keeps an MV3 service worker alive (Chromium 116+); idle limit is 30 s.
const PING_MS = 20_000;
const MAX_RETRY_MS = 30_000;

interface LinkHooks {
  status(): Promise<ExtensionStatus>;
  run<K extends Op>(op: K, params: OpMap[K]['params'], onChunk: (t: string) => void, signal: AbortSignal): Promise<unknown>;
  changed(): void;
}

async function browserName(): Promise<string> {
  const nav = navigator as Navigator & {
    brave?: { isBrave?: () => Promise<boolean> };
    userAgentData?: { brands?: Array<{ brand: string }> };
  };
  if (nav.brave && (await nav.brave.isBrave?.().catch(() => false))) return 'Brave';
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  for (const name of ['Microsoft Edge', 'Brave', 'Opera', 'Vivaldi', 'Google Chrome']) {
    if (brands.includes(name)) return name;
  }
  if (/Edg\//.test(navigator.userAgent)) return 'Microsoft Edge';
  if (/OPR\//.test(navigator.userAgent)) return 'Opera';
  return 'Chromium';
}

/** Parses a frame from the app. Returns null for anything that isn't a JSON object with a type. */
function parseFrame(raw: string): HelperToExtension | null {
  try {
    const msg: unknown = JSON.parse(raw);
    return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string' ? (msg as HelperToExtension) : null;
  } catch {
    return null;
  }
}

function healthUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/health';
  u.search = '';
  return u.toString();
}

export class HelperLink {
  state: HelperState = 'off';
  message = '';
  url = '';
  paired = false;

  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private jobs = new Map<string, AbortController>();
  private connecting = false;
  /** Pairing code used for the current connection attempt. */
  private token = '';

  constructor(private readonly hooks: LinkHooks) {}

  get connected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  private set(state: HelperState, message: string): void {
    this.state = state;
    this.message = message;
    this.hooks.changed();
  }

  /**
   * Connects if configured and not already connected. Safe to call often (e.g. from alarms).
   * A pairing code the app refused isn't retried automatically, only with `force` (the user
   * clicked Connect) or once a new code is pasted; otherwise the app would lock us out.
   */
  async connect(force = false): Promise<void> {
    if (this.connecting || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.connecting = true;
    try {
      clearTimeout(this.retryTimer);
      const conn = await getConnection();
      this.url = conn.helperUrl;
      this.paired = !!conn.pairingToken;
      if (!conn.pairingToken) return this.set('unpaired', 'Paste the pairing code from the Claude Free Bridge app.');
      if (!conn.enabled) return this.set('off', 'Disconnected. Click Connect to reconnect.');
      if (!force && conn.refused?.token === conn.pairingToken) return this.set(conn.refused.state, conn.refused.message);
      this.token = conn.pairingToken;

      let url: URL;
      try {
        url = new URL(conn.helperUrl);
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error();
      } catch {
        return this.set('disconnected', `"${conn.helperUrl}" is not a ws:// URL.`);
      }

      if (this.state !== 'disconnected') this.set('connecting', 'Connecting to the Claude Free Bridge app…');
      // Probe first so a stopped helper doesn't spam the console with WebSocket errors.
      const reachable = await fetch(healthUrl(conn.helperUrl), { mode: 'no-cors', cache: 'no-store' }).then(
        () => true,
        () => false
      );
      if (!reachable) {
        this.set('disconnected', "Can't reach the Claude Free Bridge app. Make sure it's running on this computer.");
        return this.scheduleRetry();
      }

      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        void this.sendHello(ws, conn.pairingToken, conn.instanceId).catch(() => ws.close());
      };
      ws.onmessage = (ev) => this.onMessage(ws, String(ev.data));
      ws.onclose = (ev) => this.onClose(ws, ev);
      ws.onerror = () => undefined; // onclose follows with the details
    } finally {
      this.connecting = false;
    }
  }

  private async sendHello(ws: WebSocket, token: string, instanceId: string): Promise<void> {
    this.send(ws, {
      type: 'hello',
      token,
      protocol: PROTOCOL_VERSION,
      instanceId,
      version: chrome.runtime.getManifest().version,
      browser: await browserName(),
      status: await this.hooks.status(),
    });
  }

  /** Drops any current connection and connects again with the saved settings. */
  async reconnect(): Promise<void> {
    this.dropSocket();
    this.retryMs = 1000;
    this.state = 'connecting';
    await this.connect(true);
  }

  async disconnect(): Promise<void> {
    await setConnection({ enabled: false });
    this.dropSocket();
    clearTimeout(this.retryTimer);
    this.set('off', 'Disconnected. Click Connect to reconnect.');
  }

  sendStatus(status: ExtensionStatus): void {
    if (this.connected && this.ws) this.send(this.ws, { type: 'status', status });
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.stopJobs();
    clearInterval(this.pingTimer);
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  }

  private scheduleRetry(ms = this.retryMs): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), ms);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private onMessage(ws: WebSocket, raw: string): void {
    const msg = parseFrame(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'welcome':
        this.retryMs = 1000;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send(ws, { type: 'ping' }), PING_MS);
        this.set('connected', `Connected to the Claude Free Bridge app (${msg.helperVersion})`);
        void setConnection({ refused: null });
        break;
      case 'request':
        if (typeof msg.id === 'string') void this.handleRequest(ws, msg);
        break;
      case 'cancel':
        this.jobs.get(msg.id)?.abort();
        break;
      case 'pong':
        break;
    }
  }

  private async handleRequest(ws: WebSocket, frame: RequestFrame): Promise<void> {
    const ac = new AbortController();
    this.jobs.set(frame.id, ac);
    try {
      const data = await this.hooks.run(frame.op, frame.params, (text) => this.send(ws, { type: 'chunk', id: frame.id, text }), ac.signal);
      this.send(ws, { type: 'result', id: frame.id, ok: true, data });
    } catch (e) {
      this.send(ws, { type: 'result', id: frame.id, ok: false, error: toBridgeError(e) });
    } finally {
      this.jobs.delete(frame.id);
    }
  }

  private stopJobs(): void {
    for (const ac of this.jobs.values()) ac.abort();
    this.jobs.clear();
  }

  private onClose(ws: WebSocket, ev: CloseEvent): void {
    if (this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.pingTimer);
    this.stopJobs();
    const wasConnected = this.state === 'connected';

    switch (ev.code) {
      case CloseCode.BadToken:
        this.refuse('wrong-code', ev.reason || 'Wrong pairing code. Copy it again from the Claude Free Bridge app.');
        break;
      case CloseCode.ProtocolMismatch:
      case CloseCode.TooManyAttempts:
        this.refuse('rejected', ev.reason || 'The Claude Free Bridge app refused the connection.');
        break;
      case CloseCode.Busy:
        this.set('rejected', ev.reason || 'Another browser is already connected to the app.');
        this.scheduleRetry(MAX_RETRY_MS);
        break;
      case CloseCode.Replaced:
        this.set('disconnected', 'Replaced by a newer connection from this browser.');
        break;
      default:
        this.set(
          'disconnected',
          wasConnected
            ? 'Lost the connection to the Claude Free Bridge app. Reconnecting…'
            : "Can't reach the Claude Free Bridge app. Make sure it's running on this computer."
        );
        this.scheduleRetry(wasConnected ? 1000 : undefined);
    }
  }

  /** Remembers that the app refused this pairing code, so automatic reconnects leave it alone. */
  private refuse(state: 'wrong-code' | 'rejected', message: string): void {
    this.set(state, message);
    void setConnection({ refused: { token: this.token, state, message } });
  }

  private send(ws: WebSocket, frame: ExtensionToHelper): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // closed underneath us; onclose handles it
    }
  }
}

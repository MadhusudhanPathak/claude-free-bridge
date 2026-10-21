import { BridgeFailure } from '../../shared/src/errors';
import type { SendParams, SendResult } from '../../shared/src/protocol';
import type { ExtensionLink } from './extensionLink';
import { log } from './logger';

interface QueueTimings {
  requestTimeoutMs: number;
  authWaitMs: number;
  connectWaitMs: number;
}

interface EnqueueOptions {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

interface Item extends EnqueueOptions {
  params: SendParams;
  resolve: (r: SendResult) => void;
  reject: (e: unknown) => void;
}

/**
 * Sends messages to claude.ai one at a time, in arrival order. If the claude.ai session has
 * expired, the queue holds the request (and everything behind it) until the extension reports
 * a login again, then retries it.
 */
export class SendQueue {
  private items: Item[] = [];
  private running = false;
  waitingForLogin = false;

  constructor(
    private readonly link: ExtensionLink,
    private readonly timings: QueueTimings
  ) {}

  get length(): number {
    return this.items.length;
  }

  enqueue(params: SendParams, opts: EnqueueOptions = {}): Promise<SendResult> {
    return new Promise((resolve, reject) => {
      this.items.push({ params, ...opts, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length) {
        const item = this.items[0];
        try {
          item.resolve(await this.runOne(item));
        } catch (e) {
          item.reject(e);
        }
        this.items.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(item: Item): Promise<SendResult> {
    let retriedDisconnect = false;
    // Once text has reached the client, a retry would repeat it, so only retry before that.
    let streamed = false;
    const onChunk = (text: string) => {
      streamed = true;
      item.onChunk?.(text);
    };
    for (;;) {
      if (item.signal?.aborted) throw new BridgeFailure('CANCELLED', 'Request cancelled by the client');
      await this.link.waitUntil(
        () => this.link.connected,
        this.timings.connectWaitMs,
        new BridgeFailure('EXTENSION_DISCONNECTED', 'The browser extension is not connected. Open the browser and check the extension side panel.'),
        item.signal
      );
      try {
        return await this.link.call('send', item.params, { onChunk, signal: item.signal, timeoutMs: this.timings.requestTimeoutMs });
      } catch (e) {
        if (streamed || !(e instanceof BridgeFailure)) throw e;
        if (e.code === 'AUTH_INVALID') {
          await this.waitForLogin(item.signal);
          continue;
        }
        if (e.code === 'EXTENSION_DISCONNECTED' && !retriedDisconnect) {
          retriedDisconnect = true;
          continue;
        }
        throw e;
      }
    }
  }

  private async waitForLogin(signal?: AbortSignal): Promise<void> {
    log.warn('claude.ai session expired; holding the queue until you log in again in the browser');
    this.link.markLoggedOut();
    this.waitingForLogin = true;
    try {
      await this.link.waitUntil(
        () => this.link.connected && this.link.status?.loggedIn === true,
        this.timings.authWaitMs,
        new BridgeFailure('AUTH_INVALID', 'claude.ai session expired. Log in to claude.ai in the browser and retry.'),
        signal
      );
    } finally {
      this.waitingForLogin = false;
    }
    log.info('Logged in again; retrying the held request');
  }
}

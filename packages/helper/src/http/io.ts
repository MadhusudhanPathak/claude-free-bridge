import * as crypto from 'crypto';
import type * as http from 'http';
import { BridgeFailure, toBridgeError } from '../../../shared/src/errors';
import type { BridgeError, ErrorCode } from '../../../shared/src/protocol';

const MAX_BODY_BYTES = 20 * 1024 * 1024;

const HTTP_STATUS: Record<ErrorCode, number> = {
  AUTH_INVALID: 401,
  NO_WORKER_TAB: 503,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  CANCELLED: 499,
  EXTENSION_DISCONNECTED: 503,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
};

export function badRequest(message: string): BridgeFailure {
  return new BridgeFailure('BAD_REQUEST', message);
}

export function randomId(prefix: string): string {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

/** Reads a JSON object body. An empty body reads as `{}`. */
export function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('Request body too large (max 20 MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(badRequest('Request body is not valid JSON'));
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return reject(badRequest('Request body must be a JSON object'));
      }
      resolve(parsed as Record<string, unknown>);
    });
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/** Sends `e` with the HTTP status for its code (plus Retry-After for rate limits), shaped by `format`. */
export function sendError(res: http.ServerResponse, e: unknown, format: (err: BridgeError) => unknown): void {
  const err = toBridgeError(e);
  const headers: Record<string, string> = err.retryAfter ? { 'Retry-After': String(Math.ceil(err.retryAfter)) } : {};
  sendJson(res, HTTP_STATUS[err.code], format(err), headers);
}

/** Aborts when the HTTP client goes away before the response is finished. */
export function abortOnClientGone(res: http.ServerResponse): AbortController {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac;
}

/**
 * A server-sent events response whose headers go out with the first event, so a failure
 * before any output can still get a proper HTTP status. `onStart` writes the opening events.
 */
export class LazySse {
  started = false;

  constructor(
    private readonly res: http.ServerResponse,
    private readonly onStart: () => void = () => undefined
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.onStart();
  }

  send(data: unknown, event?: string): void {
    this.start();
    if (this.res.writableEnded || this.res.destroyed) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.res.write(`${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`);
  }

  end(): void {
    this.res.end();
  }
}

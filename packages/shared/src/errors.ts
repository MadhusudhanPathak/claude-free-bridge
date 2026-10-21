import type { BridgeError, ErrorCode } from './protocol';

/** An error carrying a protocol error code, thrown on both sides of the bridge. */
export class BridgeFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'BridgeFailure';
  }

  static from(err: BridgeError): BridgeFailure {
    return new BridgeFailure(err.code, err.message, err.retryAfter);
  }
}

/** Converts anything thrown into its wire form. An aborted fetch counts as a cancellation. */
export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeFailure) return { code: e.code, message: e.message, retryAfter: e.retryAfter };
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Request cancelled' };
  }
  return { code: 'UPSTREAM_ERROR', message: e instanceof Error ? e.message : String(e) };
}

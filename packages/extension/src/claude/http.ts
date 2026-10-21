// Requests to claude.ai's internal web API, and its HTTP errors. Runs in the content script, so
// every request is same-origin and carries the page's own cookies, like the web app's requests.
import { BridgeFailure } from '../../../shared/src/errors';

interface ClaudeRequest {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
}

/** Finds a usage-limit reset time ("resetsAt", unix seconds or ms) anywhere in an error text. */
export function secondsUntilReset(text: string): number | undefined {
  const m = text.match(/resets_?at\\?"?\s*:\s*"?(\d{9,13})/i);
  if (!m) return undefined;
  let at = Number(m[1]);
  if (at > 1e12) at = at / 1000;
  return Math.max(0, Math.round(at - Date.now() / 1000));
}

async function httpError(res: Response): Promise<BridgeFailure> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 300);
  try {
    const body = JSON.parse(text);
    message = body?.error?.message || body?.detail || message;
  } catch {
    // not JSON (e.g. an HTML challenge page)
  }
  const isHtml = /<html/i.test(text);
  switch (res.status) {
    case 401:
      return new BridgeFailure('AUTH_INVALID', 'claude.ai session is not valid (logged out?)');
    case 403:
      if (!isHtml && /session|authoriz|authenticat|log ?in/i.test(text)) {
        return new BridgeFailure('AUTH_INVALID', 'claude.ai session is not valid (logged out?)');
      }
      return new BridgeFailure(
        'UPSTREAM_ERROR',
        isHtml
          ? 'claude.ai blocked the request (403 challenge page). Open claude.ai in the browser and retry.'
          : `claude.ai refused the request (403): ${message}`
      );
    case 404:
      return new BridgeFailure('NOT_FOUND', 'Not found on claude.ai (wrong conversation id?)');
    case 413:
      return new BridgeFailure('BAD_REQUEST', 'Message is too long for claude.ai');
    case 429: {
      const header = Number(res.headers.get('retry-after'));
      return new BridgeFailure(
        'RATE_LIMITED',
        `claude.ai usage limit reached: ${message}`,
        secondsUntilReset(text) ?? (Number.isFinite(header) && header > 0 ? header : undefined)
      );
    }
    default:
      return new BridgeFailure('UPSTREAM_ERROR', `claude.ai returned HTTP ${res.status}: ${message}`);
  }
}

/** Calls `/api{path}`; any non-2xx status becomes a BridgeFailure. */
export async function request(path: string, init: ClaudeRequest = {}): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: init.accept ?? 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (!res.ok) throw await httpError(res);
  return res;
}

/** Like `request`, parsing the JSON reply (undefined for an empty one). */
export async function json<T>(path: string, init: ClaudeRequest = {}): Promise<T> {
  const res = await request(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

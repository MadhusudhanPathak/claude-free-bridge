// Shared state and HTTP helpers for the Control Center page.

export interface Session {
  version: string;
  apiKey: string;
  pairingToken: string;
  apiUrl: string;
  extensionDir: string | null;
  canQuit: boolean;
}

/** The parts of GET /bridge/status the page uses. */
export interface BridgeStatus {
  extension: { connected: boolean; browser: string | null; lastRejection: { at: number; reason: string } | null };
  loggedIn: boolean | null;
  account: { email: string | null; name: string | null; org: { name: string; plan: string } } | null;
  queue: { length: number; waitingForLogin: boolean };
}

export const app = {
  /** Unlocks /ui/* (from the URL the app opened). */
  uiToken: '',
  session: null as Session | null,
};

export function session(): Session {
  if (!app.session) throw new Error('No session yet');
  return app.session;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
  }
}

/** Pulls a readable message out of any of the APIs' error shapes. */
export function errorFrom(status: number, text: string): ApiError {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j;
    return new ApiError(e.message ?? text, status, e.code ?? e.type);
  } catch {
    return new ApiError(text || `HTTP ${status}`, status);
  }
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) throw errorFrom(res.status, text);
  return JSON.parse(text) as T;
}

/** Calls the Control Center's private /ui/* API. */
export function uiRequest<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  return fetchJson<T>(path, { method, headers: { 'x-cfb-ui': app.uiToken } });
}

/** Headers for the public API, in OpenAI/bridge style or Anthropic style. */
export function apiHeaders(style: 'bearer' | 'anthropic' = 'bearer'): Record<string, string> {
  const key = app.session?.apiKey ?? '';
  return style === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

/** GET from the public API with the session's API key. */
export function getJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, { headers: apiHeaders() });
}

import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { AUTH_PATH, CONFIG_DIR, PROFILES_ROOT } from '../config/paths';
import { info, warn } from '../logger';
import { addKnownOrg } from './orgStore';
import { getAccountAuthPath, saveAccountStorageState, useAccount, clearActiveAccountMarker } from './accounts';
import { CookieBrowserId, extractSessionKeyFromBrowser } from './cookieExtract';
import { detectInstalledBrowsers } from './browsers';
import { applyStealth, STEALTH_IGNORE_DEFAULT_ARGS, STEALTH_LAUNCH_ARGS } from './stealth';

// Two ways to obtain a session, both ultimately saved as a named account (session/accounts.ts):
//
// 1. Interactive login (importAccountViaLogin) — opens a real browser window, you log in
//    normally, and the resulting session is captured automatically. This is the primary method.
// 2. Reading an already-logged-in browser's cookies directly (importAccountFromBrowser, see
//    session/cookieExtract.ts) — ported from lugia19/Claude-Usage-Extension's session model,
//    where the extension runs inside a browser the user is already logged into and reads the
//    session straight out of its cookie jar (`browser.cookies.get`) rather than logging anyone
//    in itself. No browser is opened or navigated for this method.
//
// Either way, once a session exists, fetchWithAuth/getLastActiveOrg never launch a browser —
// they just carry the stored cookie over plain HTTP.

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_ACCOUNT_NAME = 'default';

// A realistic desktop Chrome UA sent on every direct HTTP request, so requests look like
// they come from a normal browser tab rather than a script.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  text?: string;
  json?: unknown;
}

export class AuthInvalidError extends Error {
  readonly code = 'E_AUTH_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'AuthInvalidError';
  }
}

export function getStorageStatePath(): string {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return AUTH_PATH;
}

export function hasStoredAuth(): boolean {
  return fs.existsSync(AUTH_PATH);
}

function readStoredCookies(authPath: string = AUTH_PATH): StoredCookie[] {
  try {
    if (!fs.existsSync(authPath)) return [];
    const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    return Array.isArray(data?.cookies) ? data.cookies : [];
  } catch {
    return [];
  }
}

function buildCookieHeader(cookies: StoredCookie[]): string {
  return cookies
    .filter((c) => !c.domain || c.domain.includes('claude.ai'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function recordOrgFromProfileResponse(json: unknown): Promise<void> {
  if (!json || typeof json !== 'object') return;
  const data = json as { memberships?: Array<{ organization?: { uuid?: string } }>; last_active_organization?: string };
  const org = data.memberships?.[0]?.organization?.uuid || data.last_active_organization || null;
  if (org) await addKnownOrg(org);
}

function buildSessionKeyStorageState(sessionKey: string): string {
  const oneYearFromNowSeconds = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const storageState = {
    cookies: [
      {
        name: 'sessionKey',
        value: sessionKey,
        domain: '.claude.ai',
        path: '/',
        expires: oneYearFromNowSeconds,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };
  return JSON.stringify(storageState);
}

function getLoginProfileDir(accountName: string): string {
  return path.join(PROFILES_ROOT, 'login-profiles', accountName);
}

async function launchLoginBrowser(profileDir: string, browserId?: string) {
  const detected = detectInstalledBrowsers();
  const chosen = detected.find((b) => b.id === browserId) || detected[0];
  info('Using browser:', chosen.label);

  const stealthOptions = {
    headless: false,
    args: STEALTH_LAUNCH_ARGS,
    ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
    // null viewport makes the browser use its actual window size instead of Playwright's fixed
    // 1280x720 default, which is itself a detectable automation fingerprint.
    viewport: null,
  };

  try {
    if (chosen.kind === 'channel') {
      return await chromium.launchPersistentContext(profileDir, { ...stealthOptions, channel: chosen.value });
    }
    if (chosen.kind === 'executablePath') {
      return await chromium.launchPersistentContext(profileDir, { ...stealthOptions, executablePath: chosen.value });
    }
  } catch (e) {
    warn(`Failed to launch "${chosen.label}" (${(e as Error)?.message ?? e}); falling back to bundled Chromium`);
  }
  return chromium.launchPersistentContext(profileDir, stealthOptions);
}

/**
 * Opens a real browser window (preferring an installed Chrome/Edge/Brave over Playwright's
 * bundled Chromium, which is more likely to trigger bot-detection), waits for the user to log
 * into claude.ai normally, and saves the resulting session as a named account. This is the
 * primary authentication method — see importAccountFromBrowser for the cookie-only alternative
 * that never opens a browser at all.
 */
export async function importAccountViaLogin(accountName: string, browserId?: string, timeoutMs = 0): Promise<void> {
  const profileDir = getLoginProfileDir(accountName);
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const context = await launchLoginBrowser(profileDir, browserId);
  await applyStealth(context);
  const page = await context.newPage();
  try {
    await page.goto('https://claude.ai', { timeout: 60000 }).catch((e) => {
      warn('Failed to navigate to claude.ai during login:', (e as Error)?.message ?? e);
    });
    info('Complete login in the opened browser window — session will be captured automatically once you finish.');

    const maxWaitMs = timeoutMs > 0 ? timeoutMs : DEFAULT_LOGIN_TIMEOUT_MS;
    const pollIntervalMs = 2000;
    let elapsedMs = 0;
    let loggedIn = false;
    while (elapsedMs < maxWaitMs) {
      if (page.url().includes('/chat')) { loggedIn = true; break; }
      const cookies = await context.cookies('https://claude.ai').catch(() => []);
      if (cookies.some((c) => c.name === 'sessionKey' && c.value)) { loggedIn = true; break; }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      elapsedMs += pollIntervalMs;
    }

    if (!loggedIn) {
      throw new Error(
        'Login was not detected within the wait window (no sessionKey cookie and no /chat URL seen). ' +
        'Re-run auth-login and try again once you have finished logging in.'
      );
    }
    info('Login detected — saving session as account', accountName);

    const storage = await context.storageState();
    saveAccountStorageState(accountName, JSON.stringify(storage), 'interactive-login');
    useAccount(accountName);

    const org = await getLastActiveOrgForAccount(accountName).catch(() => null);
    if (org) {
      await addKnownOrg(org);
      info('Discovered and recorded org:', org);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * Saves a sessionKey under a named account slot (session/accounts.ts), mirroring the extension's
 * per-account/org model where every session is an enumerable, switchable "account" rather than a
 * single ambient login. Plain `auth-set-session <key>` (no name) saves to and activates a
 * "default" slot, so single-account use stays a one-liner.
 */
export async function importSessionKeyAsAccount(accountName: string, sessionKey: string): Promise<void> {
  const trimmed = (sessionKey || '').trim();
  if (!trimmed) throw new Error('sessionKey value is required');
  saveAccountStorageState(accountName, buildSessionKeyStorageState(trimmed), 'manual');

  const org = await getLastActiveOrgForAccount(accountName).catch(() => null);
  if (org) {
    await addKnownOrg(org);
    info('Discovered and recorded org:', org);
  }
}

export async function importSessionKey(sessionKey: string): Promise<void> {
  await importSessionKeyAsAccount(DEFAULT_ACCOUNT_NAME, sessionKey);
  useAccount(DEFAULT_ACCOUNT_NAME);
}

/**
 * Extracts the sessionKey cookie directly from an already-logged-in real browser (Chrome/Edge/
 * Brave) on this machine and saves it under a named account slot. No automated browser ever
 * navigates to claude.ai, so there is nothing for Cloudflare's bot-detection to challenge — this
 * is the direct Node equivalent of the extension reading `browser.cookies.get(...)`.
 */
export async function importAccountFromBrowser(
  accountName: string,
  browserId: CookieBrowserId,
  profileId?: string
): Promise<void> {
  const sessionKey = await extractSessionKeyFromBrowser(browserId, profileId);
  saveAccountStorageState(accountName, buildSessionKeyStorageState(sessionKey), 'browser-import');

  const org = await getLastActiveOrgForAccount(accountName).catch(() => null);
  if (org) {
    await addKnownOrg(org);
    info('Discovered and recorded org:', org);
  }
}

/**
 * Clears the currently active session (like closing out of the account) without deleting any
 * saved account's credentials — those remain switchable back to via auth-use.
 */
export async function clearStoredAuth(): Promise<void> {
  try {
    if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
  } catch {
    // best-effort cleanup
  }
  clearActiveAccountMarker();
}

export async function exportStoredAuth(destinationPath: string): Promise<string> {
  if (!hasStoredAuth()) throw new Error('No stored auth to export');
  const data = fs.readFileSync(AUTH_PATH, 'utf8');
  if (destinationPath) {
    fs.writeFileSync(destinationPath, data, { encoding: 'utf8' });
    return destinationPath;
  }
  return data;
}

async function fetchWithCookies(cookieHeader: string, url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (!cookieHeader) throw new Error('No stored auth available');

  let result: FetchResult;
  try {
    const response = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Cookie: cookieHeader,
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* response is not JSON */ }
    result = { status: response.status, ok: response.ok, text, json };
  } catch (e) {
    result = { status: 0, ok: false, text: String((e as Error)?.message ?? e) };
  }

  await recordOrgFromProfileResponse(result.json);
  return result;
}

async function getLastActiveOrgForAccount(accountName: string): Promise<string | null> {
  const cookies = readStoredCookies(getAccountAuthPath(accountName));
  const lastActive = cookies.find((c) => c.name === 'lastActiveOrg');
  if (lastActive?.value) return lastActive.value;

  const cookieHeader = buildCookieHeader(cookies);
  if (!cookieHeader) return null;
  try {
    const res = await fetchWithCookies(cookieHeader, 'https://claude.ai/api/account_profile');
    if (res.ok && res.json) {
      const data = res.json as { last_active_organization?: string; memberships?: Array<{ organization?: { uuid?: string } }> };
      return data.last_active_organization || data.memberships?.[0]?.organization?.uuid || null;
    }
  } catch {
    // caller treats null as "no org known"
  }
  return null;
}

/**
 * Reads lastActiveOrg from the active account's stored cookies, falling back to the
 * account_profile API. This is a plain HTTP lookup — no browser is launched, so it can't trip
 * Cloudflare's bot-detection challenge the way navigating an automated browser can.
 */
export async function getLastActiveOrg(): Promise<string | null> {
  if (!hasStoredAuth()) return null;

  const lastActive = readStoredCookies().find((c) => c.name === 'lastActiveOrg');
  if (lastActive?.value) return lastActive.value;

  try {
    const res = await fetchWithAuth('https://claude.ai/api/account_profile');
    if (res.ok && res.json) {
      const data = res.json as { last_active_organization?: string; memberships?: Array<{ organization?: { uuid?: string } }> };
      return data.last_active_organization || data.memberships?.[0]?.organization?.uuid || null;
    }
  } catch {
    // caller treats null as "no org known"
  }

  return null;
}

/**
 * Performs an authenticated request directly via HTTP using the active account's stored session
 * cookies — no browser is launched. A plain request carrying a valid session cookie behaves like
 * a normal returning-user request and avoids the anonymous-session bot challenge that automated
 * browser navigation can trigger.
 *
 * On a 401/403 the stored session is treated as dead (mirrors the extension's assumption that an
 * unreachable/expired cookie means the user needs to be logged into that browser again) — the
 * active session is cleared and AuthInvalidError is thrown for the caller to handle. There is no
 * automatic re-login: the operator must re-run auth-set-session / auth-import-browser, or switch
 * to another saved account with auth-use.
 */
export async function fetchWithAuth(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (!hasStoredAuth()) throw new Error('No stored auth available');
  const cookieHeader = buildCookieHeader(readStoredCookies());
  if (!cookieHeader) throw new Error('No stored auth available');

  const result = await fetchWithCookies(cookieHeader, url, opts);

  if (result.status === 401 || result.status === 403) {
    await clearStoredAuth();
    throw new AuthInvalidError(
      `Authentication failed (status ${result.status}). Stored session cleared. Run auth-set-session, ` +
      'auth-import-browser, or auth-use <name> to re-authenticate.'
    );
  }

  return result;
}

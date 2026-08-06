import * as fs from 'fs';
import * as path from 'path';
import { chromium, BrowserContextOptions } from 'playwright';
import { AUTH_PATH, CONFIG_DIR, PROFILE_DIR, PROFILES_ROOT } from '../config/paths';
import { info, warn } from '../logger';
import { addKnownOrg } from './orgStore';
import { detectInstalledBrowsers } from './browsers';
import { applyStealth, STEALTH_IGNORE_DEFAULT_ARGS, STEALTH_LAUNCH_ARGS } from './stealth';

// A realistic desktop Chrome UA sent on every direct HTTP request, so requests look like
// they come from a normal browser tab rather than a script.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

export function getContextOptionsFromStoredAuth(): BrowserContextOptions | undefined {
  if (!hasStoredAuth()) return undefined;
  return { storageState: getStorageStatePath() };
}

export function getProfileDirForOrg(orgId: string): string {
  return path.join(PROFILES_ROOT, orgId || 'default');
}

export function getAuthPathForOrg(orgId: string): string {
  return path.join(getProfileDirForOrg(orgId), 'auth.json');
}

export function hasStoredAuthForOrg(orgId: string): boolean {
  return fs.existsSync(getAuthPathForOrg(orgId));
}

export function getContextOptionsForOrg(orgId?: string): BrowserContextOptions | undefined {
  if (orgId && hasStoredAuthForOrg(orgId)) return { storageState: getAuthPathForOrg(orgId) };
  if (hasStoredAuth()) return { storageState: getStorageStatePath() };
  return undefined;
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

/**
 * Import an authenticated session directly from the sessionKey cookie value, obtained by the
 * user from their own already-logged-in browser (DevTools > Application > Cookies > claude.ai
 * > sessionKey). This avoids driving an automated browser through claude.ai's login flow,
 * which is commonly blocked by Cloudflare's bot-detection challenge on fresh/anonymous sessions.
 */
export async function importSessionKey(sessionKey: string, orgId?: string): Promise<void> {
  const trimmed = (sessionKey || '').trim();
  if (!trimmed) throw new Error('sessionKey value is required');

  const authPath = orgId ? getAuthPathForOrg(orgId) : AUTH_PATH;
  const dir = path.dirname(authPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const oneYearFromNowSeconds = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const storageState = {
    cookies: [
      {
        name: 'sessionKey',
        value: trimmed,
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

  fs.writeFileSync(authPath, JSON.stringify(storageState), { encoding: 'utf8' });
  info('Imported session cookie to', authPath);

  const org = await getLastActiveOrg().catch(() => null);
  if (org) {
    await addKnownOrg(org);
    info('Discovered and recorded org:', org);
  }
}

async function launchLoginBrowser(profileDir: string, headed: boolean, browserId?: string) {
  const detected = detectInstalledBrowsers();
  const chosen = detected.find((b) => b.id === browserId) || detected[0];
  info('Using browser:', chosen.label);

  const stealthOptions = {
    headless: !headed,
    args: STEALTH_LAUNCH_ARGS,
    ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
    // null viewport makes a headed browser use its actual window size instead of Playwright's
    // fixed 1280x720 default, which is itself a detectable automation fingerprint.
    viewport: headed ? null : undefined,
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
 * Drives an interactive login: opens a real browser (preferring an installed Chrome/Edge/Brave
 * over Playwright's bundled Chromium, which is more likely to trigger bot-detection), waits for
 * the user to log in, and captures the resulting session automatically.
 */
export async function ensureAuthForOrg(orgId?: string, headed = true, timeoutMs = 0, browserId?: string): Promise<void> {
  const profileDir = orgId ? getProfileDirForOrg(orgId) : PROFILE_DIR;
  const authPath = orgId ? getAuthPathForOrg(orgId) : AUTH_PATH;
  if (fs.existsSync(authPath)) {
    info('Auth storage already exists at', authPath);
    return;
  }

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const context = await launchLoginBrowser(profileDir, headed, browserId);
  await applyStealth(context);
  const page = await context.newPage();
  try {
    await page.goto('https://claude.ai', { timeout: 60000 }).catch((e) => {
      warn('Failed to navigate to claude.ai during login:', (e as Error)?.message ?? e);
    });
    info('Complete login in the opened browser — session will be captured automatically once you finish.');

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
      warn(
        'Login was not detected within the wait window (no sessionKey cookie and no /chat URL seen). ' +
        'Saving storageState anyway, but it may be unauthenticated — re-run auth-info --login if requests fail.'
      );
    } else {
      info('Login detected — extracting session automatically.');
    }

    try {
      const storage = await context.storageState();
      fs.writeFileSync(authPath, JSON.stringify(storage), { encoding: 'utf8' });
      info('Saved storageState to', authPath);
    } catch (e) {
      warn('Failed to write storageState:', (e as Error)?.message ?? e);
    }

    const org = await getLastActiveOrg().catch(() => null);
    if (org) {
      await addKnownOrg(org);
      info('Discovered and recorded org:', org);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function ensureAuth(headed = true, timeoutMs = 0, browserId?: string): Promise<void> {
  return ensureAuthForOrg(undefined, headed, timeoutMs, browserId);
}

export async function clearStoredAuth(removeProfile = false): Promise<void> {
  try {
    if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
  } catch {
    // best-effort cleanup
  }
  if (removeProfile) {
    try {
      if (fs.existsSync(PROFILE_DIR)) fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
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

/**
 * Reads lastActiveOrg from stored session cookies, falling back to the account_profile API.
 * This is a plain HTTP lookup — no browser is launched, so it can't trip Cloudflare's
 * bot-detection challenge the way navigating an automated browser can.
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
 * Performs an authenticated request directly via HTTP using the stored session cookies — no
 * browser is launched. A plain request carrying a valid session cookie behaves like a normal
 * returning-user request and avoids the anonymous-session bot challenge that automated
 * browser navigation can trigger.
 */
export async function fetchWithAuth(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (!hasStoredAuth()) throw new Error('No stored auth available');
  const cookieHeader = buildCookieHeader(readStoredCookies());
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

  if (result.status === 401 || result.status === 403) {
    await clearStoredAuth();
    throw new AuthInvalidError(
      `Authentication failed (status ${result.status}). Stored auth cleared. Please run auth-set-session or auth-info --login to re-auth.`
    );
  }

  await recordOrgFromProfileResponse(result.json);

  return result;
}

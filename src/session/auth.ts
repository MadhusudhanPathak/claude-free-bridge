import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { chromium, BrowserContextOptions, BrowserContext, Page } from 'playwright';
import { debug, info, warn, error } from '../logger';

const CONFIG_DIR = path.join(os.homedir(), '.claude-free-bridge');
const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');
const PROFILE_DIR = path.join(CONFIG_DIR, 'profile');
const PROFILES_ROOT = path.join(CONFIG_DIR, 'profiles');

export function getStorageStatePath(): string {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return AUTH_PATH;
}

export function hasStoredAuth(): boolean {
  return fs.existsSync(AUTH_PATH);
}

/**
 * Improved ensureAuth:
 * - Launches a persistent profile so cookies/localStorage persist
 * - Waits for /chat navigation (configurable timeout)
 * - Saves storageState to auth.json
 */
export async function ensureAuth(headed = true, timeoutMs = 0): Promise<void> {
  if (hasStoredAuth()) {
    console.log('Auth storage already exists at', AUTH_PATH);
    return;
  }

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('Launching persistent browser for interactive login (profile at', PROFILE_DIR, ')');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: !headed });
  const page = await context.newPage();
  try {
    await page.goto('https://claude.ai', { timeout: 60000 }).catch(() => {});
    console.log('Complete login in the opened browser. Waiting for /chat...');

    const max = timeoutMs && timeoutMs > 0 ? timeoutMs : 5 * 60 * 1000;
    let elapsed = 0;
    const interval = 2000;
    while (elapsed < max) {
      try {
        const url = page.url();
        if (url && url.includes('/chat')) break;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, interval));
      elapsed += interval;
    }

    // Save storage state to file
    try {
      const storage = await context.storageState();
      fs.writeFileSync(AUTH_PATH, JSON.stringify(storage), { encoding: 'utf8' });
      console.log('Saved storageState to', AUTH_PATH);
    } catch (e) {
      console.warn('Failed to write storageState:', (e as any)?.message ?? e);
    }

    // Try to auto-discover and persist the active org id
    try {
      const last = await getLastActiveOrg();
      if (last) {
        // lazy import to avoid cycle
        const { addKnownOrg } = await import('./org_store');
        await addKnownOrg(last);
        console.log('Discovered and recorded org:', last);
      }
    } catch (e) {
      // non-fatal
    }
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

export function getContextOptionsFromStoredAuth(): BrowserContextOptions | undefined {
  if (!hasStoredAuth()) return undefined;
  return { storageState: getStorageStatePath() } as BrowserContextOptions;
}

export function getProfileDirForOrg(orgId: string) {
  return path.join(PROFILES_ROOT, orgId || 'default');
}

export function getAuthPathForOrg(orgId: string) {
  const dir = getProfileDirForOrg(orgId);
  return path.join(dir, 'auth.json');
}

export function hasStoredAuthForOrg(orgId: string): boolean {
  return fs.existsSync(getAuthPathForOrg(orgId));
}

export function getContextOptionsForOrg(orgId?: string): BrowserContextOptions | undefined {
  if (orgId && hasStoredAuthForOrg(orgId)) return { storageState: getAuthPathForOrg(orgId) } as BrowserContextOptions;
  // Fallbacks
  if (hasStoredAuth()) return { storageState: getStorageStatePath() } as BrowserContextOptions;
  return undefined;
}

export async function ensureAuthForOrg(orgId?: string, headed = true, timeoutMs = 0): Promise<void> {
  // Use profile dir per org
  const profileDir = orgId ? getProfileDirForOrg(orgId) : PROFILE_DIR;
  const authPath = orgId ? getAuthPathForOrg(orgId) : AUTH_PATH;
  if (fs.existsSync(authPath)) {
    info('Auth storage already exists at', authPath);
    return;
  }

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  info('Launching persistent browser for interactive login (profile at', profileDir, ')');
  const context = await chromium.launchPersistentContext(profileDir, { headless: !headed });
  const page = await context.newPage();
  try {
    await page.goto('https://claude.ai', { timeout: 60000 }).catch(() => {});
    info('Complete login in the opened browser. Waiting for /chat...');

    const max = timeoutMs && timeoutMs > 0 ? timeoutMs : 5 * 60 * 1000;
    let elapsed = 0;
    const interval = 2000;
    while (elapsed < max) {
      try {
        const url = page.url();
        if (url && url.includes('/chat')) break;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, interval));
      elapsed += interval;
    }

    // Save storage state to file
    try {
      const storage = await context.storageState();
      fs.writeFileSync(authPath, JSON.stringify(storage), { encoding: 'utf8' });
      info('Saved storageState to', authPath);
    } catch (e) {
      warn('Failed to write storageState:', (e as any)?.message ?? e);
    }

    // Try to auto-discover and persist the active org id
    try {
      const last = await getLastActiveOrg();
      if (last) {
        // lazy import to avoid cycle
        const { addKnownOrg } = await import('./org_store');
        await addKnownOrg(last);
        info('Discovered and recorded org:', last);
      }
    } catch (e) {
      // non-fatal
    }
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

export async function ensureAuth(headed = true, timeoutMs = 0): Promise<void> {
  return ensureAuthForOrg(undefined, headed, timeoutMs);
}

export async function clearStoredAuth(removeProfile = false) {
  try {
    if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
  } catch (e) {}
  if (removeProfile) {
    try {
      if (fs.existsSync(PROFILE_DIR)) {
        // remove profile directory recursively
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      }
    } catch (e) {}
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
 * Read lastActiveOrg from the stored session. Attempts (in order):
 *  1) read cookies from a context created with stored storageState
 *  2) open a page in that context and read document.cookie
 * Returns the cookie value or null.
 */
export async function getLastActiveOrg(): Promise<string | null> {
  if (!hasStoredAuth()) return null;

  const ctxOpts = getContextOptionsFromStoredAuth();
  if (!ctxOpts) return null;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(ctxOpts);
  let page: Page | undefined;
  try {
    // Try cookie read first
    const cookies = await context.cookies('https://claude.ai');
    const lastActive = cookies.find((c) => c.name === 'lastActiveOrg');
    if (lastActive && lastActive.value) {
      return lastActive.value;
    }

    // Fallback: open a page and read document.cookie
    page = await context.newPage();
    await page.goto('https://claude.ai/chat', { timeout: 60000 }).catch(() => {});
    const docCookie = await page.evaluate(() => document.cookie) as string;
    if (docCookie) {
      const match = docCookie.split('; ').map(s => s.trim()).find(s => s.startsWith('lastActiveOrg='));
      if (match) return match.split('=')[1] || null;
    }

    // Final fallback: ask account_profile for an org id
    try {
      const res = await fetchWithAuth('https://claude.ai/api/account_profile');
      if (res && res.ok && res.json) {
        const org = res.json?.last_active_organization || (res.json?.memberships || [])[0]?.organization?.uuid || null;
        if (org) return org;
      }
    } catch (e) {
      // ignore
    }

    return null;
  } catch (e) {
    return null;
  } finally {
    try { if (page) await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/**
 * Perform an authenticated fetch within the stored session by evaluating fetch inside a page
 * so cookies/localStorage are always included. Returns an object with status and text/json.
 */
export async function fetchWithAuth(url: string, opts: { method?: string; headers?: any; body?: any } = {}): Promise<{ status: number; ok: boolean; text?: string; json?: any; } > {
  if (!hasStoredAuth()) throw new Error('No stored auth available');
  const ctxOpts = getContextOptionsFromStoredAuth();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  try {
    await page.goto('https://claude.ai/chat', { timeout: 60000 }).catch(() => {});
    const payload = { u: url, o: { method: opts.method || 'GET', headers: opts.headers || undefined, body: opts.body || undefined } };
    const result = await page.evaluate(async (arg: any) => {
      const u: string = arg.u;
      const o: any = arg.o || {};
      try {
        const r = await fetch(u, { ...(o || {}), credentials: 'include' });
        const txt = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch (e) { /* not json */ }
        return { status: r.status, ok: r.ok, text: txt, json: parsed };
      } catch (e) {
        return { status: 0, ok: false, text: String(e) };
      }
    }, payload);

    // If auth appears invalid, clear stored auth to force re-auth flow
    if (result && (result.status === 401 || result.status === 403)) {
      try {
        await clearStoredAuth();
      } catch (e) {}
      const err: any = new Error('Authentication failed (status ' + result.status + '). Stored auth cleared. Please run auth-info --login to re-auth.');
      err.code = 'E_AUTH_INVALID';
      throw err;
    }

    // If this looks like account_profile JSON, try to record the org id
    try {
      if (result && result.json && typeof result.json === 'object') {
        const org = (result.json?.memberships || [])[0]?.organization?.uuid || result.json?.last_active_organization || null;
        if (org) {
          const { addKnownOrg } = await import('./org_store');
          await addKnownOrg(org);
        }
      }
    } catch (e) {
      // non-fatal
    }

    return result as any;
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

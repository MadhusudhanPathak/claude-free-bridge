import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import initSqlJs from 'sql.js';
import { chromium } from 'playwright';
import { info, warn } from '../logger';
import { detectInstalledBrowsers } from './browsers';
import { applyStealth, STEALTH_IGNORE_DEFAULT_ARGS, STEALTH_LAUNCH_ARGS } from './stealth';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJsStatic['Database']>;

export type CookieBrowserId = 'chrome' | 'msedge' | 'brave';

interface BrowserDataDir {
  id: CookieBrowserId;
  label: string;
  userDataDir: string;
}

export interface CookieProfile {
  id: string; // profile directory name, e.g. "Default", "Profile 1"
  displayName: string;
}

// Cookie DB decryption hits Chrome's App-Bound Encryption (v20 cookies) and needs the browser
// relaunch fallback below rather than surfacing directly to the caller.
class AppBoundEncryptionError extends Error {}

function candidateDataDirs(): BrowserDataDir[] {
  const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  return [
    { id: 'chrome', label: 'Google Chrome', userDataDir: path.join(local, 'Google', 'Chrome', 'User Data') },
    { id: 'msedge', label: 'Microsoft Edge', userDataDir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
    { id: 'brave', label: 'Brave', userDataDir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  ];
}

function readLocalState(userDataDir: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
  } catch {
    return null;
  }
}

export function listInstalledCookieBrowsers(): { id: CookieBrowserId; label: string }[] {
  return candidateDataDirs()
    .filter((d) => fs.existsSync(d.userDataDir))
    .map((d) => ({ id: d.id, label: d.label }));
}

export function listCookieProfiles(browserId: CookieBrowserId): CookieProfile[] {
  const dataDir = candidateDataDirs().find((d) => d.id === browserId);
  if (!dataDir || !fs.existsSync(dataDir.userDataDir)) return [];

  const infoCache = readLocalState(dataDir.userDataDir)?.profile?.info_cache || {};
  return fs
    .readdirSync(dataDir.userDataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
    .map((e) => ({ id: e.name, displayName: infoCache[e.name]?.name || infoCache[e.name]?.user_name || e.name }));
}

function findCookiesDbPath(userDataDir: string, profileId: string): string | null {
  const candidates = [
    path.join(userDataDir, profileId, 'Network', 'Cookies'),
    path.join(userDataDir, profileId, 'Cookies'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Chrome/Edge/Brave on Windows encrypt cookie values with an AES-256-GCM key that is itself
 * protected via Windows DPAPI (tied to the logged-in Windows user). Node has no built-in DPAPI
 * binding, but PowerShell's `System.Security.Cryptography.ProtectedData` does, so we shell out
 * for just that one step rather than pulling in a native addon.
 */
function decryptDpapi(blob: Buffer): Buffer {
  if (process.platform !== 'win32') {
    throw new Error('Automatic browser-cookie import is only implemented on Windows.');
  }
  const script =
    // Some environments run PowerShell with command auto-loading disabled (e.g. via policy),
    // so Add-Type resolves fine as a core cmdlet but the type it loads is invisible until the
    // Utility module is imported explicitly.
    `Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop; ` +
    `Add-Type -AssemblyName System.Security; ` +
    `$b = [Convert]::FromBase64String('${blob.toString('base64')}'); ` +
    `$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, ` +
    `[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Convert]::ToBase64String($d)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return Buffer.from(out.trim(), 'base64');
}

function getAesKey(userDataDir: string): Buffer {
  const encoded = readLocalState(userDataDir)?.os_crypt?.encrypted_key;
  if (!encoded) throw new Error('Could not find os_crypt.encrypted_key in this browser\'s Local State file.');
  const raw = Buffer.from(encoded, 'base64');
  const dpapiPrefixLen = Buffer.byteLength('DPAPI');
  return decryptDpapi(raw.subarray(dpapiPrefixLen));
}

function decryptCookieValue(encryptedValue: Buffer, key: Buffer): string {
  const version = encryptedValue.subarray(0, 3).toString('latin1');
  if (version === 'v20') {
    throw new AppBoundEncryptionError("Cookie uses Chrome's App-Bound Encryption (v20)");
  }
  if (version !== 'v10' && version !== 'v11') {
    throw new Error(`Unrecognized cookie encryption version "${version}".`);
  }

  const nonce = encryptedValue.subarray(3, 15);
  const ciphertext = encryptedValue.subarray(15, encryptedValue.length - 16);
  const tag = encryptedValue.subarray(encryptedValue.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Reads the claude.ai `sessionKey` cookie straight out of a real browser's own (encrypted)
 * cookie database, decrypting it ourselves via DPAPI. Fast and needs no browser process — but
 * fails on newer Chrome profiles protected by App-Bound Encryption (v20 cookies), where the
 * decryption key isn't obtainable via plain DPAPI at all (see extractSessionKeyViaBrowserRelaunch).
 */
async function extractSessionKeyFromCookieDb(dataDir: BrowserDataDir, profileId: string): Promise<string> {
  const dbPath = findCookiesDbPath(dataDir.userDataDir, profileId);
  if (!dbPath) {
    throw new Error(`Could not find a cookies database for profile "${profileId}" in ${dataDir.label}.`);
  }

  // The browser holds a write lock on its live cookie DB, so read from a copy instead. While
  // the browser is actually running, Chromium can hold that lock exclusively enough to block
  // even a plain file copy on Windows.
  const tmpPath = path.join(os.tmpdir(), `claude-fb-cookies-${process.pid}-${Date.now()}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EBUSY') {
      throw new Error(
        `${dataDir.label}'s cookie database is locked. Close all ${dataDir.label} windows completely ` +
        '(check the system tray / Task Manager, since it often keeps running in the background) and try again.'
      );
    }
    throw e;
  }

  let db: SqlDatabase | undefined;
  try {
    const SQL = await initSqlJs();
    db = new SQL.Database(fs.readFileSync(tmpPath));
    const results = db.exec(
      "SELECT host_key, encrypted_value FROM cookies WHERE name = 'sessionKey' AND host_key LIKE '%claude.ai'"
    );

    if (!results.length || !results[0].values.length) {
      throw new Error(
        `No claude.ai sessionKey cookie found in ${dataDir.label}'s "${profileId}" profile. ` +
        'Make sure you are logged into claude.ai there first.'
      );
    }

    const row = results[0].values[0];
    const encryptedValue = Buffer.from(row[1] as Uint8Array);
    const key = getAesKey(dataDir.userDataDir);
    const sessionKey = decryptCookieValue(encryptedValue, key);
    info(`Extracted sessionKey from ${dataDir.label} profile "${profileId}" (DB decrypt)`);
    return sessionKey;
  } finally {
    db?.close();
    fs.rmSync(tmpPath, { force: true });
  }
}

// Directories that are large and never needed just to have Chrome recognize a profile and serve
// its cookies back to us over CDP.
const SKIP_DIR_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'GrShaderCache',
  'ShaderCache', 'Service Worker', 'blob_storage', 'IndexedDB', 'Local Storage',
  'Session Storage', 'File System', 'Media Cache', 'CacheStorage', 'WebStorage',
  'Extension Rules', 'Extension State', 'Extensions', 'component_crx_cache', 'Crashpad',
  'optimization_guide_model_store', 'BudgetDatabase',
]);

function copyProfileDirBestEffort(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyProfileDirBestEffort(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {
        // Locked/in-use files (e.g. a live Cookies DB) are best-effort here — the cookie DB
        // itself is copied explicitly with a clear error below if that specific copy fails.
      }
    }
  }
}

/**
 * Builds a throwaway copy of just enough of a real browser's profile for that same browser
 * binary to launch against it and serve its own (already-decrypted) cookies back to us — the
 * fallback for Chrome's App-Bound Encryption (v20 cookies), where the encryption key can't be
 * unwrapped via plain DPAPI at all: the key is only released to a legitimately-signed, running
 * copy of the browser itself. This is the direct Node equivalent of the extension's
 * `browser.cookies.get(...)` — instead of decrypting the browser's private files ourselves, we
 * launch the real browser and ask it.
 */
function buildTempProfileCopy(dataDir: BrowserDataDir, profileId: string): string {
  const tmpUserData = path.join(os.tmpdir(), `claude-fb-profile-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpUserData, { recursive: true });

  const localStateSrc = path.join(dataDir.userDataDir, 'Local State');
  if (!fs.existsSync(localStateSrc)) {
    throw new Error(`Could not find ${dataDir.label}'s "Local State" file.`);
  }
  fs.copyFileSync(localStateSrc, path.join(tmpUserData, 'Local State'));

  const dbPath = findCookiesDbPath(dataDir.userDataDir, profileId);
  if (!dbPath) {
    throw new Error(`Could not find a cookies database for profile "${profileId}" in ${dataDir.label}.`);
  }
  const destDbPath = path.join(tmpUserData, path.relative(dataDir.userDataDir, dbPath));
  fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
  try {
    fs.copyFileSync(dbPath, destDbPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EBUSY') {
      throw new Error(
        `${dataDir.label}'s cookie database is locked. Close all ${dataDir.label} windows completely ` +
        '(check the system tray / Task Manager, since it often keeps running in the background) and try again.'
      );
    }
    throw e;
  }

  // Best-effort: Preferences and friends make Chrome treat this as a normal existing profile
  // rather than a fresh/damaged one. Not fatal if any individual file can't be copied.
  copyProfileDirBestEffort(path.join(dataDir.userDataDir, profileId), path.join(tmpUserData, profileId));

  return tmpUserData;
}

function playwrightLaunchOptionsFor(browserId: CookieBrowserId): { channel?: string; executablePath?: string } {
  const detected = detectInstalledBrowsers().find((b) => b.id === browserId);
  if (!detected) throw new Error(`${browserId} does not appear to be installed on this machine.`);
  if (detected.kind === 'channel') return { channel: detected.value };
  if (detected.kind === 'executablePath') return { executablePath: detected.value };
  throw new Error(`${browserId} could not be resolved to a launchable browser.`);
}

/**
 * Briefly launches the real browser (headless) against a throwaway copy of the target profile
 * and reads the sessionKey cookie back through Playwright's CDP connection — the browser itself
 * decrypts it, so this works regardless of DPAPI vs. App-Bound Encryption. No page is ever
 * navigated; nothing touches claude.ai directly.
 */
async function extractSessionKeyViaBrowserRelaunch(
  dataDir: BrowserDataDir,
  browserId: CookieBrowserId,
  profileId: string
): Promise<string> {
  const tmpUserData = buildTempProfileCopy(dataDir, profileId);
  let context;
  try {
    context = await chromium.launchPersistentContext(tmpUserData, {
      ...playwrightLaunchOptionsFor(browserId),
      headless: true,
      args: [...STEALTH_LAUNCH_ARGS, `--profile-directory=${profileId}`],
      ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
    });
    await applyStealth(context);
    const cookies = await context.cookies('https://claude.ai');
    const sessionCookie = cookies.find((c) => c.name === 'sessionKey');
    if (!sessionCookie?.value) {
      throw new Error(
        `No claude.ai sessionKey cookie found in ${dataDir.label}'s "${profileId}" profile. ` +
        'Make sure you are logged into claude.ai there first.'
      );
    }
    info(`Extracted sessionKey from ${dataDir.label} profile "${profileId}" (browser relaunch)`);
    return sessionCookie.value;
  } finally {
    await context?.close().catch(() => {});
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
}

/**
 * Reads the claude.ai `sessionKey` cookie out of a real browser's own profile. The user just
 * needs to already be logged into claude.ai there — no automation ever navigates to claude.ai
 * itself, so there is nothing for Cloudflare to challenge.
 *
 * Tries a direct DPAPI-based DB decrypt first (fast, no browser process). Chrome profiles
 * protected by App-Bound Encryption (v20 cookies) can't be decrypted that way at all, so those
 * fall back to briefly relaunching the real browser headless and asking it for the cookie
 * directly (see extractSessionKeyViaBrowserRelaunch).
 */
export async function extractSessionKeyFromBrowser(browserId: CookieBrowserId, profileId = 'Default'): Promise<string> {
  const dataDir = candidateDataDirs().find((d) => d.id === browserId);
  if (!dataDir || !fs.existsSync(dataDir.userDataDir)) {
    throw new Error(`${browserId} does not appear to be installed on this machine.`);
  }

  try {
    return await extractSessionKeyFromCookieDb(dataDir, profileId);
  } catch (e) {
    if (!(e instanceof AppBoundEncryptionError)) throw e;
    warn(`${dataDir.label} uses App-Bound Encryption (v20 cookies) — falling back to a brief background browser read.`);
    return extractSessionKeyViaBrowserRelaunch(dataDir, browserId, profileId);
  }
}

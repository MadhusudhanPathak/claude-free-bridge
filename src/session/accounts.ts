import * as fs from 'fs';
import * as path from 'path';
import { AUTH_PATH, CONFIG_DIR, PROFILES_ROOT } from '../config/paths';
import { info } from '../logger';

const ACCOUNTS_INDEX_PATH = path.join(CONFIG_DIR, 'accounts.json');
const ACTIVE_ACCOUNT_PATH = path.join(CONFIG_DIR, 'active_account');
const ACCOUNTS_ROOT = path.join(PROFILES_ROOT, 'accounts');

export interface AccountEntry {
  name: string;
  addedAt: string;
  source: 'manual' | 'browser-import' | 'interactive-login';
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readIndex(): AccountEntry[] {
  ensureConfigDir();
  try {
    if (!fs.existsSync(ACCOUNTS_INDEX_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_INDEX_PATH, 'utf8') || '[]');
    return Array.isArray(data) ? (data as AccountEntry[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(entries: AccountEntry[]): void {
  ensureConfigDir();
  fs.writeFileSync(ACCOUNTS_INDEX_PATH, JSON.stringify(entries, null, 2), { encoding: 'utf8' });
}

export function getAccountAuthPath(name: string): string {
  return path.join(ACCOUNTS_ROOT, name, 'auth.json');
}

export function listAccounts(): AccountEntry[] {
  return readIndex();
}

export function getActiveAccountName(): string | null {
  try {
    if (!fs.existsSync(ACTIVE_ACCOUNT_PATH)) return null;
    return fs.readFileSync(ACTIVE_ACCOUNT_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Saves a storageState JSON blob under a named account slot. If no account is currently
 * active, this one becomes active automatically (so single-account setups keep working with
 * zero extra steps) — otherwise switching remains an explicit `auth-use` call.
 */
export function saveAccountStorageState(name: string, storageStateJson: string, source: AccountEntry['source']): void {
  const authPath = getAccountAuthPath(name);
  const dir = path.dirname(authPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(authPath, storageStateJson, { encoding: 'utf8' });

  const entries = readIndex().filter((e) => e.name !== name);
  entries.push({ name, addedAt: new Date().toISOString(), source });
  writeIndex(entries);
  info('Saved account', name, 'at', authPath);

  if (!getActiveAccountName()) {
    useAccount(name);
  }
}

export function useAccount(name: string): void {
  const authPath = getAccountAuthPath(name);
  if (!fs.existsSync(authPath)) {
    throw new Error(`No stored account named "${name}". Run auth-accounts to list saved accounts.`);
  }
  ensureConfigDir();
  fs.copyFileSync(authPath, AUTH_PATH);
  fs.writeFileSync(ACTIVE_ACCOUNT_PATH, name, { encoding: 'utf8' });
  info('Switched active account to', name);
}

/**
 * Clears which account is "active" without deleting any saved account's credentials — used when
 * logging out of the current session (see auth-clear) while leaving saved accounts importable
 * again via auth-use.
 */
export function clearActiveAccountMarker(): void {
  try {
    if (fs.existsSync(ACTIVE_ACCOUNT_PATH)) fs.unlinkSync(ACTIVE_ACCOUNT_PATH);
  } catch {
    // best-effort cleanup
  }
}

export function removeAccount(name: string): void {
  const dir = path.dirname(getAccountAuthPath(name));
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  writeIndex(readIndex().filter((e) => e.name !== name));
  if (getActiveAccountName() === name) {
    try { fs.unlinkSync(ACTIVE_ACCOUNT_PATH); } catch { /* best-effort */ }
  }
  info('Removed account', name);
}

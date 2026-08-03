import * as fs from 'fs';
import { CONFIG_DIR, KNOWN_ORGS_PATH } from '../config/paths';
import { info, debug } from '../logger';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredEntry {
  orgId: string;
  expiresAt: number;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readStore(): StoredEntry[] {
  ensureConfigDir();
  try {
    if (!fs.existsSync(KNOWN_ORGS_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(KNOWN_ORGS_PATH, 'utf8') || '[]');
    return Array.isArray(data) ? (data as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

function writeStore(entries: StoredEntry[]): void {
  ensureConfigDir();
  fs.writeFileSync(KNOWN_ORGS_PATH, JSON.stringify(entries, null, 2), { encoding: 'utf8' });
}

export async function addKnownOrg(orgId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
  if (!orgId) return;
  const entries = readStore().filter((e) => e.orgId !== orgId);
  entries.push({ orgId, expiresAt: Date.now() + ttlMs });
  writeStore(entries);
  info('Added known org', orgId);
}

export async function getKnownOrgs(): Promise<string[]> {
  const now = Date.now();
  const entries = readStore();
  const kept = entries.filter((e) => e.expiresAt > now);
  if (kept.length !== entries.length) writeStore(kept);
  debug('Known orgs', kept.map((e) => e.orgId));
  return kept.map((e) => e.orgId);
}

export async function clearKnownOrgs(): Promise<void> {
  writeStore([]);
  info('Cleared known orgs');
}

export async function removeKnownOrg(orgId: string): Promise<void> {
  const entries = readStore().filter((e) => e.orgId !== orgId);
  writeStore(entries);
  info('Removed known org', orgId);
}

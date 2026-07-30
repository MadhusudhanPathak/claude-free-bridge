import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const CONFIG_DIR = path.join(os.homedir(), '.claude-free-bridge');
const KNOWN_ORGS_PATH = path.join(CONFIG_DIR, 'known_orgs.json');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredEntry {
  orgId: string;
  expiresAt: number;
}

import { info, warn, debug } from '../logger';

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readStore(): StoredEntry[] {
  ensureConfigDir();
  try {
    if (!fs.existsSync(KNOWN_ORGS_PATH)) return [];
    const txt = fs.readFileSync(KNOWN_ORGS_PATH, 'utf8');
    const data = JSON.parse(txt || '[]');
    if (!Array.isArray(data)) return [];
    return data as StoredEntry[];
  } catch (e) {
    return [];
  }
}

function writeStore(entries: StoredEntry[]) {
  ensureConfigDir();
  fs.writeFileSync(KNOWN_ORGS_PATH, JSON.stringify(entries, null, 2), { encoding: 'utf8' });
}

export async function addKnownOrg(orgId: string, ttlMs: number = DEFAULT_TTL_MS) {
  if (!orgId) return;
  const entries = readStore().filter(e => e.orgId !== orgId);
  entries.push({ orgId, expiresAt: Date.now() + ttlMs });
  writeStore(entries);
  try { info('Added known org', orgId); } catch {}
}

export async function getKnownOrgs(): Promise<string[]> {
  const now = Date.now();
  const entries = readStore();
  const kept = entries.filter(e => e.expiresAt > now);
  // Cleanup if some expired
  if (kept.length !== entries.length) writeStore(kept);
  try { debug('Known orgs', kept.map(e => e.orgId)); } catch {}
  return kept.map(e => e.orgId);
}

export async function clearKnownOrgs() {
  writeStore([]);
  try { info('Cleared known orgs'); } catch {}
}

export async function removeKnownOrg(orgId: string) {
  const entries = readStore().filter(e => e.orgId !== orgId);
  writeStore(entries);
  try { info('Removed known org', orgId); } catch {}
}

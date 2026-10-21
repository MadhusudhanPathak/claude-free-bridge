import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_PORT } from '../../shared/src/protocol';

/** Everything the app keeps on disk lives here. CLAUDE_FB_HOME overrides it (used by tests). */
export const CONFIG_DIR = process.env.CLAUDE_FB_HOME || path.join(os.homedir(), '.claude-free-bridge');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const LOG_PATH = path.join(CONFIG_DIR, 'helper.log');

export interface HelperConfig {
  /** Required on every API request (Authorization: Bearer … or x-api-key). */
  apiKey: string;
  /** Pasted once into the extension's side panel; required to connect over WebSocket. */
  pairingToken: string;
  /** Unlocks the Control Center page, which shows the two secrets above. */
  uiToken: string;
  host: string;
  port: number;
  /** Browser origins allowed to call the HTTP API (e.g. a local web UI). */
  allowedOrigins: string[];
  /** Longest a single reply from claude.ai may take. */
  requestTimeoutMs: number;
  /** How long a queued request waits for the user to log back in to claude.ai. */
  authWaitMs: number;
  /** How long a request waits for the extension to (re)connect. */
  connectWaitMs: number;
}

type Secrets = Pick<HelperConfig, 'apiKey' | 'pairingToken' | 'uiToken'>;

const DEFAULTS: Omit<HelperConfig, keyof Secrets> = {
  host: '127.0.0.1',
  port: DEFAULT_PORT,
  allowedOrigins: [],
  requestTimeoutMs: 10 * 60 * 1000,
  authWaitMs: 10 * 60 * 1000,
  connectWaitMs: 20 * 1000,
};

export function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 0 && (port as number) <= 65535;
}

function newApiKey(): string {
  return `cfb-${crypto.randomBytes(24).toString('base64url')}`;
}

function newPairingToken(): string {
  return `cfbpair-${crypto.randomBytes(18).toString('base64url')}`;
}

function newUiToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function invalid(field: string, expected: string): Error {
  return new Error(`"${field}" in ${CONFIG_PATH} must be ${expected}. Fix it, or delete the file to start over.`);
}

/** Reads config.json. A missing or empty file is a first run; a broken one is an error, so it is never overwritten. */
function readStored(): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_PATH} is not valid JSON (${(e as Error).message}). Fix it, or delete the file to start over.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object. Fix it, or delete the file to start over.`);
  }
  return parsed as Record<string, unknown>;
}

/** Checks the stored values, using defaults for missing ones and new secrets where none exist yet. */
function validate(stored: Record<string, unknown>): HelperConfig {
  const text = (field: keyof HelperConfig, fallback: () => string): string => {
    const v = stored[field];
    if (v === undefined || v === '') return fallback();
    if (typeof v !== 'string') throw invalid(field, 'a string');
    return v;
  };
  const duration = (field: 'requestTimeoutMs' | 'authWaitMs' | 'connectWaitMs'): number => {
    const v = stored[field];
    if (v === undefined) return DEFAULTS[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalid(field, 'a number of milliseconds');
    return v;
  };

  const port = stored.port ?? DEFAULTS.port;
  if (!isValidPort(port)) throw invalid('port', 'a whole number from 0 to 65535');
  const origins = stored.allowedOrigins ?? DEFAULTS.allowedOrigins;
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === 'string')) throw invalid('allowedOrigins', 'a list of strings');

  return {
    ...stored,
    apiKey: text('apiKey', newApiKey),
    pairingToken: text('pairingToken', newPairingToken),
    uiToken: text('uiToken', newUiToken),
    host: text('host', () => DEFAULTS.host),
    port,
    allowedOrigins: origins,
    requestTimeoutMs: duration('requestTimeoutMs'),
    authWaitMs: duration('authWaitMs'),
    connectWaitMs: duration('connectWaitMs'),
  };
}

export function saveConfig(cfg: HelperConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** Loads config.json, filling in defaults and generating secrets on first run. */
export function loadConfig(): HelperConfig {
  const stored = readStored();
  const cfg = validate(stored);
  if (JSON.stringify(cfg) !== JSON.stringify(stored)) saveConfig(cfg);
  return cfg;
}

/** A new API key and pairing code. Doesn't save; callers decide. */
export function newSecrets(): Pick<HelperConfig, 'apiKey' | 'pairingToken'> {
  return { apiKey: newApiKey(), pairingToken: newPairingToken() };
}

/** Replaces the API key and pairing code in config.json. */
export function rotateSecrets(): HelperConfig {
  const cfg = { ...loadConfig(), ...newSecrets() };
  saveConfig(cfg);
  return cfg;
}

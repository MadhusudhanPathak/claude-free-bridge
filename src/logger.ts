import * as fs from 'fs';
import { CONFIG_DIR, LOG_PATH } from './config/paths';

let telemetryEnabled = process.env.CLAUDE_FB_TELEMETRY === '1';

export function enableTelemetry(enabled: boolean): void {
  telemetryEnabled = !!enabled;
}

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {
    // best-effort; logging must never crash the caller
  }
}

function writeLogLine(line: string): void {
  if (!telemetryEnabled) return;
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_PATH, line + '\n', { encoding: 'utf8' });
  } catch {
    // best-effort; logging must never crash the caller
  }
}

function formatMessage(level: string, args: unknown[]): string {
  return [level, new Date().toISOString(), ...args]
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

export function debug(...args: unknown[]): void {
  const msg = formatMessage('DEBUG', args);
  console.debug(msg);
  writeLogLine(msg);
}

export function info(...args: unknown[]): void {
  const msg = formatMessage('INFO', args);
  console.log(msg);
  writeLogLine(msg);
}

export function warn(...args: unknown[]): void {
  const msg = formatMessage('WARN', args);
  console.warn(msg);
  writeLogLine(msg);
}

export function error(...args: unknown[]): void {
  const msg = formatMessage('ERROR', args);
  console.error(msg);
  writeLogLine(msg);
}

export default { debug, info, warn, error, enableTelemetry };

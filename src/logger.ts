import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.claude-free-bridge');
const LOG_PATH = path.join(CONFIG_DIR, 'bridge.log');

let telemetryEnabled = process.env.CLAUDE_FB_TELEMETRY === '1' || false;

export function enableTelemetry(v: boolean) {
  telemetryEnabled = !!v;
}

function ensureLogDir() {
  try { if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (e) {}
}

function writeLogLine(line: string) {
  if (!telemetryEnabled) return;
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_PATH, line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // swallow
  }
}

export function debug(...args: any[]) {
  const msg = ['DEBUG', new Date().toISOString(), ...args].map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.debug(msg);
  writeLogLine(msg);
}

export function info(...args: any[]) {
  const msg = ['INFO', new Date().toISOString(), ...args].map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(msg);
  writeLogLine(msg);
}

export function warn(...args: any[]) {
  const msg = ['WARN', new Date().toISOString(), ...args].map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.warn(msg);
  writeLogLine(msg);
}

export function error(...args: any[]) {
  const msg = ['ERROR', new Date().toISOString(), ...args].map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.error(msg);
  writeLogLine(msg);
}

export default { debug, info, warn, error, enableTelemetry };

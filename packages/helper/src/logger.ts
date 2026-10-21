import * as fs from 'fs';
import { CONFIG_DIR, LOG_PATH } from './config';

// Diagnostic logging. CLAUDE_FB_DEBUG=1 shows debug lines; CLAUDE_FB_LOG=1 also appends
// everything to ~/.claude-free-bridge/helper.log. CLAUDE_FB_QUIET=1 silences the console (tests).
const debugEnabled = process.env.CLAUDE_FB_DEBUG === '1';
const fileEnabled = process.env.CLAUDE_FB_LOG === '1';
const quiet = process.env.CLAUDE_FB_QUIET === '1';

function format(level: string, args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return `${new Date().toISOString()} ${level} ${parts.join(' ')}`;
}

function write(level: string, args: unknown[], sink: (line: string) => void): void {
  const line = format(level, args);
  if (!quiet) sink(line);
  if (!fileEnabled) return;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // logging must never crash the caller
  }
}

export const log = {
  debug: (...args: unknown[]) => debugEnabled && write('DEBUG', args, console.log),
  info: (...args: unknown[]) => write('INFO', args, console.log),
  warn: (...args: unknown[]) => write('WARN', args, console.warn),
  error: (...args: unknown[]) => write('ERROR', args, console.error),
};

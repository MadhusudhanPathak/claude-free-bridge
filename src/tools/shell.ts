import { exec } from 'child_process';
import * as util from 'util';

const execAsync = util.promisify(exec);

const DEFAULT_TIMEOUT_MS = 30000;

const DENYLIST = ['rm -rf /', 'mkfs', 'dd if=', String.raw`curl .*\|.*bash`, 'shutdown', 'reboot'];

export interface RunShellOptions {
  yes?: boolean;
  timeout?: number;
}

export type ShellResult =
  | { ok: true; exit_code: 0; stdout: string; stderr: string }
  | { ok: false; error: string; stdout?: string; stderr?: string; exit_code?: number };

function isDangerous(command: string): boolean {
  const lower = command.toLowerCase();
  return DENYLIST.some((pattern) => {
    try {
      return new RegExp(pattern).test(lower);
    } catch {
      return lower.includes(pattern);
    }
  });
}

export async function runShellCommand(command: string, workspace = '.', opts: RunShellOptions = {}): Promise<ShellResult> {
  if (!command || !command.trim()) return { ok: false, error: 'empty_command' };
  if (isDangerous(command) && !opts.yes) return { ok: false, error: 'destructive_command_requires_confirmation' };

  try {
    const { stdout, stderr } = await execAsync(command, { cwd: workspace, timeout: opts.timeout || DEFAULT_TIMEOUT_MS });
    return { ok: true, exit_code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { message?: string; stdout?: string; stderr?: string; code?: number };
    return { ok: false, error: e.message ?? String(err), stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code ?? 1 };
  }
}

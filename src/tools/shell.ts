import { exec } from 'child_process';
import * as util from 'util';
import * as path from 'path';
const execP = util.promisify(exec);

const DENYLIST = [
  'rm -rf /',
  'mkfs',
  'dd if=',
  'curl .*\|.*bash',
  'shutdown',
  'reboot',
];

function isDangerous(cmd: string) {
  const low = cmd.toLowerCase();
  return DENYLIST.some((p) => {
    try { const re = new RegExp(p); return re.test(low); } catch { return low.includes(p); }
  });
}

export async function runShellCommand(command: string, workspace = '.', opts: any = {}): Promise<any> {
  if (!command || command.trim().length === 0) return { ok: false, error: 'empty_command' };
  if (isDangerous(command) && !opts.yes) {
    return { ok: false, error: 'destructive_command_requires_confirmation' };
  }
  try {
    const cwd = workspace;
    const timeout = opts.timeout || 30000;
    const res = await execP(command, { cwd, timeout });
    return { ok: true, exit_code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err: any) {
    // child_process exec throws on non-zero exit; capture output if present
    return { ok: false, error: err?.message ?? String(err), stdout: err?.stdout ?? '', stderr: err?.stderr ?? '', exit_code: err?.code ?? 1 };
  }
}

// Desktop-app behaviour: where the extension folder is, and opening windows/folders for the user.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

/** True when running as the standalone ClaudeFreeBridge.exe (a Node single-executable app). */
function isStandaloneExe(): boolean {
  try {
    // node:sea doesn't exist on older Node versions (the npm route), hence the try.
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

/** The unpacked extension folder users load into their browser, or null if it can't be found. */
export function findExtensionDir(): string | null {
  const candidates = isStandaloneExe()
    ? [path.join(path.dirname(process.execPath), 'extension')]
    : [path.resolve(__dirname, '..', '..', 'extension', 'dist')]; // packages/helper/dist → packages/extension/dist
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'manifest.json'))) ?? null;
}

function run(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => log.warn(`Could not run ${cmd}: ${e.message}`));
    child.unref();
    return true;
  } catch (e) {
    log.warn(`Could not run ${cmd}: ${(e as Error).message}`);
    return false;
  }
}

function findEdge(): string | null {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  for (const root of roots) {
    const exe = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** Opens the Control Center: an app-style Edge window on Windows, else the default browser. */
export function openWindow(url: string): void {
  if (process.platform === 'win32') {
    const edge = findEdge();
    if (edge && run(edge, [`--app=${url}`, '--window-size=1280,900'])) return;
    run('rundll32', ['url.dll,FileProtocolHandler', url]);
  } else if (process.platform === 'darwin') {
    run('open', [url]);
  } else {
    run('xdg-open', [url]);
  }
}

export function openFolder(dir: string): void {
  if (process.platform === 'win32') run('explorer.exe', [dir]);
  else if (process.platform === 'darwin') run('open', [dir]);
  else run('xdg-open', [dir]);
}

export function controlCenterUrl(baseUrl: string, uiToken: string): string {
  return `${baseUrl}/#ui=${uiToken}`;
}

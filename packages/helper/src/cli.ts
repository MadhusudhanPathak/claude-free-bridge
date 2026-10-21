#!/usr/bin/env node
import { BRIDGE_VERSION } from '../../shared/src/protocol';
import { controlCenterUrl, findExtensionDir, openFolder, openWindow } from './app';
import { CONFIG_PATH, type HelperConfig, isValidPort, loadConfig, rotateSecrets, saveConfig } from './config';
import { log } from './logger';
import { isLoopbackHost } from './security';
import { type RunningHelper, startHelper } from './server';

const HELP = `Claude Free Bridge ${BRIDGE_VERSION}

Usage:
  claude-free-bridge                 Start and open the Control Center (same as double-clicking the app)
  claude-free-bridge serve [--host <host>] [--port <port>]
                                     Start without opening a window (servers, development)
  claude-free-bridge token [--rotate]
                                     Show (or regenerate) the API key and pairing code
  claude-free-bridge status          Ask a running instance for its status

Settings file: ${CONFIG_PATH}
`;

/** The value after `--name`, or undefined if the flag isn't given. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function localUrl(cfg: HelperConfig): string {
  const host = isLoopbackHost(cfg.host) || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  return `http://${host}:${cfg.port}`;
}

/** When started by double-click, keep the console open long enough to read an error. */
async function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return;
  console.log('\nPress Enter to close this window.');
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function isOurHelperRunning(cfg: HelperConfig): Promise<boolean> {
  try {
    const res = await fetch(`${localUrl(cfg)}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function start(args: string[], openControlCenter: boolean): Promise<void> {
  process.title = 'Claude Free Bridge';
  const cfg = loadConfig();
  cfg.host = flag(args, '--host') ?? cfg.host;
  const port = flag(args, '--port');
  if (port !== undefined) {
    cfg.port = Number(port);
    if (!isValidPort(cfg.port)) throw new Error(`Invalid port "${port}"`);
  }

  const extensionDir = findExtensionDir();
  let helper: RunningHelper | undefined;
  try {
    helper = await startHelper(cfg, {
      extensionDir,
      saveConfig,
      openFolder,
      onQuit: () => {
        console.log('\nStopped from the Control Center.');
        void helper?.close().then(() => process.exit(0));
      },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    if (await isOurHelperRunning(cfg)) {
      // Started a second time: bring up the running copy's Control Center instead.
      console.log('Claude Free Bridge is already running. Opening the Control Center…');
      if (openControlCenter) openWindow(controlCenterUrl(localUrl(cfg), cfg.uiToken));
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    console.error(
      `Port ${cfg.port} is already used by another program.\n` +
        `Close that program, or change "port" in ${CONFIG_PATH} (and the App address in the extension's side panel).`
    );
    await waitForEnter();
    process.exit(1);
  }

  const running = helper;
  const uiUrl = controlCenterUrl(running.url, cfg.uiToken);
  console.log(`
  Claude Free Bridge ${BRIDGE_VERSION} is running.

  Control Center:  ${uiUrl}
  API address:     ${running.url}

  Keep this window open while you use Claude Free Bridge. Close it to stop.
`);
  if (!isLoopbackHost(cfg.host)) {
    console.log(`  WARNING: listening on ${cfg.host}, not just this computer. Anyone who can reach it and has the API key can use your claude.ai session.\n`);
  }
  if (!extensionDir) log.warn('The extension folder was not found next to the app; the Control Center cannot point to it.');
  if (openControlCenter) openWindow(uiUrl);

  running.link.on('status', (s) => {
    if (s && !s.loggedIn) log.warn('The browser is not logged in to claude.ai');
  });

  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  const res = await fetch(`${localUrl(cfg)}/bridge/status`, { headers: { authorization: `Bearer ${cfg.apiKey}` } }).catch(() => null);
  if (!res) {
    console.error(`Claude Free Bridge isn't running on port ${cfg.port}.`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await res.json(), null, 2));
}

function token(args: string[]): void {
  const rotate = args.includes('--rotate');
  const cfg = rotate ? rotateSecrets() : loadConfig();
  if (rotate) console.log('New API key and pairing code generated. Restart Claude Free Bridge and pair the extension again.');
  console.log(`  API key:       ${cfg.apiKey}`);
  console.log(`  Pairing code:  ${cfg.pairingToken}`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'start':
      return start(args, true);
    case 'serve':
      return start(args, false);
    case 'token':
      return token(args);
    case 'status':
      return status();
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return;
    case '-v':
    case '--version':
      console.log(BRIDGE_VERSION);
      return;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch(async (e) => {
  console.error(`Claude Free Bridge could not start: ${e instanceof Error ? e.message : e}`);
  await waitForEnter();
  process.exit(1);
});

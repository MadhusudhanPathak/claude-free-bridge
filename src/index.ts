import { Command } from 'commander';
import { agentLoop } from './orchestrator/loop';
import {
  clearStoredAuth,
  ensureAuth,
  exportStoredAuth,
  fetchWithAuth,
  getLastActiveOrg,
  importSessionKey,
} from './session/auth';
import { detectInstalledBrowsers } from './session/browsers';
import { sendPromptViaPlaywright } from './transport/playwright';
import { enableTelemetry } from './logger';
import { startServer } from './api';

const pkg = require('../package.json');
const program = new Command();

interface RunOptions {
  workspace: string;
  yes?: boolean;
}

interface ListBrowsersOptions {
  json?: boolean;
}

interface AuthInfoOptions {
  login?: boolean;
  browser?: string;
}

interface AuthClearOptions {
  profile?: boolean;
}

interface ProbeOptions {
  headed?: boolean;
}

interface TelemetryOptions {
  on?: boolean;
  off?: boolean;
}

interface ServeOptions {
  host: string;
  port: string;
}

async function promptForBrowserChoice(): Promise<string | undefined> {
  const browsers = detectInstalledBrowsers();
  if (browsers.length === 1) return browsers[0].id;
  if (!process.stdin.isTTY) return undefined; // non-interactive; caller falls back to the default browser

  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Select a browser to use for login:');
    browsers.forEach((b, i) => console.log(`  ${i + 1}. ${b.label}`));
    const answer = await rl.question(`Enter a number [1-${browsers.length}] (default 1): `);
    const choice = parseInt(answer.trim(), 10);
    return choice >= 1 && choice <= browsers.length ? browsers[choice - 1].id : browsers[0].id;
  } finally {
    rl.close();
  }
}

program.name('claude-free-bridge').description(pkg.description).version(pkg.version);

program
  .command('run')
  .argument('[task]', 'Task description for the agent')
  .option('--workspace <path>', 'Workspace directory', '.')
  .option('--yes', 'Skip confirmations for destructive actions')
  .action(async (task: string | undefined, opts: RunOptions) => {
    try {
      await agentLoop(task ?? 'Run a quick probe', { workspace: opts.workspace, yes: !!opts.yes });
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('list-browsers')
  .description('Detect browsers installed on this machine that can be used for interactive login')
  .option('--json', 'Print raw JSON instead of a human-readable list')
  .action((opts: ListBrowsersOptions) => {
    const browsers = detectInstalledBrowsers();
    if (opts.json) {
      console.log(JSON.stringify(browsers));
      return;
    }
    console.log('Detected browsers:');
    browsers.forEach((b, i) => console.log(`  ${i + 1}. ${b.label} (id: ${b.id})`));
  });

program
  .command('auth-info')
  .description('Show authentication info: lastActiveOrg and account_profile')
  .option('--login', 'Open interactive login flow if no stored auth')
  .option('--browser <id>', 'Browser id to use for login (see list-browsers); prompts interactively if omitted')
  .action(async (opts: AuthInfoOptions) => {
    try {
      if (opts.login) {
        const browserId = opts.browser || (await promptForBrowserChoice());
        await ensureAuth(true, 0, browserId);
      }

      const org = await getLastActiveOrg();
      console.log('lastActiveOrg:', org);

      try {
        const res = await fetchWithAuth('https://claude.ai/api/account_profile');
        if (res.ok) {
          console.log('account_profile:', res.json ?? JSON.parse(res.text || '{}'));
        } else {
          console.warn('Failed to fetch account_profile, status:', res.status);
        }
      } catch (e) {
        console.warn('Error fetching account_profile:', e);
      }
    } catch (e) {
      console.error('Error:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('auth-set-session')
  .description(
    'Import an existing claude.ai session by pasting the sessionKey cookie value from your ' +
    'own already-logged-in browser (DevTools > Application > Storage > Cookies > https://claude.ai > sessionKey). ' +
    "Avoids driving an automated browser through login, which claude.ai's bot-detection commonly blocks."
  )
  .argument('<sessionKey>', 'Value of the sessionKey cookie')
  .action(async (sessionKey: string) => {
    try {
      await importSessionKey(sessionKey);
      console.log('Session imported. Run "auth-info" to verify.');
    } catch (e) {
      console.error('Failed to import session:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('auth-clear')
  .description('Clear stored auth (auth.json). Use --profile to also delete Playwright profile directory')
  .option('--profile', 'Also remove persisted profile directory')
  .action(async (opts: AuthClearOptions) => {
    try {
      await clearStoredAuth(!!opts.profile);
      console.log('Stored auth cleared');
    } catch (e) {
      console.error('Failed to clear auth:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('auth-export')
  .description('Export stored auth.json to the provided path (or print to stdout if not provided)')
  .argument('[path]', 'Destination file path')
  .action(async (pathArg: string | undefined) => {
    try {
      if (pathArg) {
        console.log('Exported auth to', await exportStoredAuth(pathArg));
      } else {
        console.log(await exportStoredAuth(''));
      }
    } catch (e) {
      console.error('Failed to export auth:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('probe')
  .description('Send a quick prompt via the Playwright transport (requires auth)')
  .argument('[prompt]', 'Prompt to send', 'Say hello')
  .option('--headed', 'Open a visible browser', false)
  .action(async (prompt: string, opts: ProbeOptions) => {
    try {
      console.log('Response:\n', await sendPromptViaPlaywright(prompt, { headed: !!opts.headed }));
    } catch (e) {
      console.error('Probe failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('telemetry')
  .description('Enable or disable file telemetry logging. Use --on or --off')
  .option('--on', 'Enable telemetry')
  .option('--off', 'Disable telemetry')
  .action((opts: TelemetryOptions) => {
    if (opts.on) {
      enableTelemetry(true);
      console.log('Telemetry enabled (writes to ~/.claude-free-bridge/bridge.log)');
    } else if (opts.off) {
      enableTelemetry(false);
      console.log('Telemetry disabled');
    } else {
      console.log('Specify --on or --off');
    }
  });

program
  .command('serve')
  .description('Start HTTP API server (Anthropic-compatible endpoints)')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('--port <port>', 'Port to bind', '8080')
  .action((opts: ServeOptions) => {
    startServer({ host: opts.host, port: parseInt(opts.port, 10) || 8080 });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

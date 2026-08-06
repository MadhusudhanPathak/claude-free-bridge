import { Command } from 'commander';
import { agentLoop } from './orchestrator/loop';
import {
  clearStoredAuth,
  exportStoredAuth,
  fetchWithAuth,
  getLastActiveOrg,
  importAccountFromBrowser,
  importAccountViaLogin,
  importSessionKey,
  importSessionKeyAsAccount,
} from './session/auth';
import { getActiveAccountName, listAccounts, removeAccount, useAccount } from './session/accounts';
import { CookieBrowserId, listCookieProfiles, listInstalledCookieBrowsers } from './session/cookieExtract';
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

interface AuthLoginOptions {
  browser?: string;
}

interface AuthSetSessionOptions {
  account?: string;
}

interface AuthImportBrowserOptions {
  browser?: string;
  profile?: string;
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

async function promptForChoice<T>(question: string, choices: { label: string }[], items: T[]): Promise<T | undefined> {
  if (choices.length <= 1) return items[0];
  if (!process.stdin.isTTY) return items[0];

  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(question);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
    const answer = await rl.question(`Enter a number [1-${choices.length}] (default 1): `);
    const choice = parseInt(answer.trim(), 10);
    return choice >= 1 && choice <= choices.length ? items[choice - 1] : items[0];
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
  .description('Detect real installed browsers on this machine that the transport can drive to talk to claude.ai')
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
  .description('Show authentication info: lastActiveOrg and account_profile for the active session')
  .action(async () => {
    try {
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
  .command('auth-login')
  .description(
    'Primary authentication method: opens a real browser window, you log into claude.ai ' +
    'normally, and the session is captured automatically the moment login completes and saved ' +
    'as a named account.'
  )
  .argument('[accountName]', 'Account name to save this login under', 'default')
  .option('--browser <id>', 'Browser id to use for login (see list-browsers); prompts interactively if omitted')
  .action(async (accountName: string, opts: AuthLoginOptions) => {
    try {
      const browserId = opts.browser || (await promptForBrowserChoice());
      await importAccountViaLogin(accountName, browserId);
      console.log(`Logged in and saved as account "${accountName}". Run "auth-accounts" to see saved accounts.`);
    } catch (e) {
      console.error('Login failed:', e instanceof Error ? e.message : e);
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
  .option('--account <name>', 'Save as a named account instead of the single global session (see auth-accounts)')
  .action(async (sessionKey: string, opts: AuthSetSessionOptions) => {
    try {
      if (opts.account) {
        await importSessionKeyAsAccount(opts.account, sessionKey);
        console.log(`Session imported as account "${opts.account}". Run "auth-accounts" to see saved accounts.`);
      } else {
        await importSessionKey(sessionKey);
        console.log('Session imported. Run "auth-info" to verify.');
      }
    } catch (e) {
      console.error('Failed to import session:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('list-cookie-browsers')
  .description('List installed browsers (Chrome/Edge/Brave) that auth-import-browser can read a session cookie from')
  .option('--json', 'Print raw JSON instead of a human-readable list')
  .action((opts: ListBrowsersOptions) => {
    const browsers = listInstalledCookieBrowsers();
    if (opts.json) {
      console.log(JSON.stringify(browsers));
      return;
    }
    console.log('Browsers available for cookie import:');
    browsers.forEach((b, i) => console.log(`  ${i + 1}. ${b.label} (id: ${b.id})`));
  });

program
  .command('list-cookie-profiles')
  .description('List profiles within a browser (see list-cookie-browsers)')
  .argument('<browserId>', 'Browser id: chrome, msedge, or brave')
  .option('--json', 'Print raw JSON instead of a human-readable list')
  .action((browserId: string, opts: ListBrowsersOptions) => {
    const profiles = listCookieProfiles(browserId as CookieBrowserId);
    if (opts.json) {
      console.log(JSON.stringify(profiles));
      return;
    }
    console.log(`Profiles for ${browserId}:`);
    profiles.forEach((p, i) => console.log(`  ${i + 1}. ${p.displayName} (id: ${p.id})`));
  });

program
  .command('auth-import-browser')
  .description(
    'Extract the sessionKey cookie directly from an already-logged-in real browser (Chrome/Edge/Brave) ' +
    'on this machine and save it as a named account. No automated browser touches claude.ai, so there is ' +
    "nothing for Cloudflare's bot-detection to challenge."
  )
  .argument('<accountName>', 'Name to save this account under (see auth-accounts / auth-use)')
  .option('--browser <id>', 'Browser to read cookies from: chrome, msedge, or brave (prompts if omitted)')
  .option('--profile <id>', 'Browser profile directory name, e.g. "Default" or "Profile 1" (prompts if omitted)')
  .action(async (accountName: string, opts: AuthImportBrowserOptions) => {
    try {
      const browsers = listInstalledCookieBrowsers();
      if (!browsers.length) {
        throw new Error('No supported browser (Chrome, Edge, Brave) with a User Data folder was found.');
      }

      const browser =
        browsers.find((b) => b.id === opts.browser) ||
        (await promptForChoice('Select a browser to read the claude.ai session from:', browsers, browsers));
      if (!browser) throw new Error('No browser selected.');

      const profiles = listCookieProfiles(browser.id);
      if (!profiles.length) {
        throw new Error(`No profiles found for ${browser.label}.`);
      }
      const profile =
        profiles.find((p) => p.id === opts.profile) ||
        (await promptForChoice(
          `Select a ${browser.label} profile:`,
          profiles.map((p) => ({ label: p.displayName })),
          profiles
        ));
      if (!profile) throw new Error('No profile selected.');

      await importAccountFromBrowser(accountName, browser.id as CookieBrowserId, profile.id);
      console.log(`Session imported from ${browser.label} ("${profile.displayName}") as account "${accountName}".`);
      console.log('Run "auth-accounts" to see saved accounts, or "auth-use" to switch between them.');
    } catch (e) {
      console.error('Failed to import from browser:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('auth-accounts')
  .description('List saved named accounts and which one is currently active')
  .option('--json', 'Print raw JSON instead of a human-readable list')
  .action((opts: ListBrowsersOptions) => {
    const accounts = listAccounts();
    const active = getActiveAccountName();

    if (opts.json) {
      console.log(JSON.stringify(accounts.map((a) => ({ ...a, active: a.name === active }))));
      return;
    }

    if (!accounts.length) {
      console.log('No named accounts saved yet. Use auth-set-session --account <name> or auth-import-browser.');
      return;
    }
    console.log('Saved accounts:');
    accounts.forEach((a) => {
      const marker = a.name === active ? '* ' : '  ';
      console.log(`${marker}${a.name} (source: ${a.source}, added: ${a.addedAt})`);
    });
  });

program
  .command('auth-use')
  .description('Switch the active claude.ai account to a previously saved named account')
  .argument('<name>', 'Account name (see auth-accounts)')
  .action((name: string) => {
    try {
      useAccount(name);
      console.log(`Active account switched to "${name}".`);
    } catch (e) {
      console.error('Failed to switch account:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('auth-remove-account')
  .description('Delete a saved named account')
  .argument('<name>', 'Account name (see auth-accounts)')
  .action((name: string) => {
    try {
      removeAccount(name);
      console.log(`Removed account "${name}".`);
    } catch (e) {
      console.error('Failed to remove account:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('auth-clear')
  .description('Clear the active session (saved named accounts are untouched — see auth-use to switch back)')
  .action(async () => {
    try {
      await clearStoredAuth();
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

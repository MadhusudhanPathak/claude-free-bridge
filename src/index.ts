import { Command } from 'commander';
import { agentLoop } from './orchestrator/loop';
import { getLastActiveOrg, fetchWithAuth, ensureAuth } from './session/auth';
import { sendPromptViaPlaywright } from './transport/playwright';
import { enableTelemetry } from './logger';
import { startServer } from './api';

const pkg = require('../package.json');
const program = new Command();

program.name('claude-free-bridge').description(pkg.description).version(pkg.version);

program
  .command('run')
  .argument('[task]', 'Task description for the agent')
  .option('--workspace <path>', 'Workspace directory', '.')
  .option('--yes', 'Skip confirmations for destructive actions')
  .action(async (task: string | undefined, opts: any) => {
    console.log('Workspace:', opts.workspace);
    const userTask = task ?? 'Run a quick probe';
    try {
      await agentLoop(userTask, { workspace: opts.workspace, yes: !!opts.yes });
    } catch (err: any) {
      console.error('Error:', err?.message ?? err);
      process.exit(1);
    }
  });

program
  .command('auth-info')
  .description('Show authentication info: lastActiveOrg and account_profile')
  .option('--login', 'Open interactive login flow if no stored auth')
  .action(async (opts: any) => {
    try {
      if (opts.login) {
        await ensureAuth(true, 0);
      }
      const org = await getLastActiveOrg();
      console.log('lastActiveOrg:', org);

      try {
        const res = await fetchWithAuth('https://claude.ai/api/account_profile');
        if (res.ok) {
          console.log('account_profile:', res.json ?? JSON.parse((res.text || '') || '{}'));
        } else {
          console.warn('Failed to fetch account_profile, status:', res.status);
        }
      } catch (e) {
        console.warn('Error fetching account_profile:', e);
      }
    } catch (e: any) {
      console.error('Error:', e?.message ?? e);
      process.exit(1);
    }
  });

program
  .command('auth-clear')
  .description('Clear stored auth (auth.json). Use --profile to also delete Playwright profile directory')
  .option('--profile', 'Also remove persisted profile directory')
  .action(async (opts: any) => {
    try {
      const { clearStoredAuth } = await import('./session/auth');
      await clearStoredAuth(!!opts.profile);
      console.log('Stored auth cleared');
    } catch (e: any) {
      console.error('Failed to clear auth:', e?.message ?? e);
      process.exit(1);
    }
  });

program
  .command('auth-export')
  .description('Export stored auth.json to the provided path (or print to stdout if not provided)')
  .argument('[path]', 'Destination file path')
  .action(async (pathArg: string | undefined) => {
    try {
      const { exportStoredAuth } = await import('./session/auth');
      if (pathArg) {
        const dest = await exportStoredAuth(pathArg);
        console.log('Exported auth to', dest);
      } else {
        const data = await exportStoredAuth('');
        console.log(data);
      }
    } catch (e: any) {
      console.error('Failed to export auth:', e?.message ?? e);
      process.exit(1);
    }
  });

program
  .command('probe')
  .description('Send a quick prompt via the Playwright transport (requires auth)')
  .argument('[prompt]', 'Prompt to send', 'Say hello')
  .option('--headed', 'Open a visible browser', false)
  .action(async (prompt: string, opts: any) => {
    try {
      const res = await sendPromptViaPlaywright(prompt, { headed: !!opts.headed });
      console.log('Response:\n', res);
    } catch (e: any) {
      console.error('Probe failed:', e?.message ?? e);
      process.exit(1);
    }
  });

program
  .command('telemetry')
  .description('Enable or disable file telemetry logging. Use --on or --off')
  .option('--on', 'Enable telemetry')
  .option('--off', 'Disable telemetry')
  .action((opts: any) => {
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
  .action((opts: any) => {
    const port = parseInt(opts.port, 10) || 8080;
    const host = opts.host || '127.0.0.1';
    startServer({ host, port });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

# auth_version_01 — archived auth implementation

This file archives the original auth implementation (auth.ts) and related notes from agent.md before replacing it with a new implementation.

## Original src/session/auth.ts

```ts
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { chromium, BrowserContextOptions } from 'playwright';

const CONFIG_DIR = path.join(os.homedir(), '.claude-free-bridge');
const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');
const PROFILE_DIR = path.join(CONFIG_DIR, 'profile');

export function getStorageStatePath(): string {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return AUTH_PATH;
}

export function hasStoredAuth(): boolean {
  return fs.existsSync(AUTH_PATH);
}

export async function ensureAuth(headed = true, timeoutMs = 0): Promise<void> {
  // If auth exists, nothing to do
  if (hasStoredAuth()) {
    console.log('Auth storage found at', AUTH_PATH);
    return;
  }

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('No stored auth found. Launching persistent headed browser for interactive login (profile saved at', PROFILE_DIR, ')');

  // Use a persistent context so the browser stores cookies/localStorage in a real profile
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: !headed });
  const page = await context.newPage();
  try {
    await page.goto('https://claude.ai', { timeout: 60000 }).catch(() => {});
    console.log('Please complete login in the opened browser window. Waiting for navigation to /chat ...');

    // Wait for navigation to /chat, with an upper bound
    const max = timeoutMs && timeoutMs > 0 ? timeoutMs : 5 * 60 * 1000;
    let elapsed = 0;
    const interval = 2000;
    while (elapsed < max) {
      try {
        const url = page.url();
        if (url && url.includes('/chat')) break;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, interval));
      elapsed += interval;
    }

    // Save storage state
    try {
      const storage = await context.storageState();
      fs.writeFileSync(AUTH_PATH, JSON.stringify(storage), { encoding: 'utf8' });
      console.log('Saved auth storage to', AUTH_PATH);
    } catch (e) {
      console.warn('Failed to write storageState:', (e as any)?.message ?? e);
    }
  } finally {
    try { await page.close(); } catch {}
    // Do NOT close the persistent context immediately; closing will still keep profile on disk.
    try { await context.close(); } catch {}
  }
}

export function getContextOptionsFromStoredAuth(): BrowserContextOptions | undefined {
  if (!hasStoredAuth()) return undefined;
  return { storageState: getStorageStatePath() } as BrowserContextOptions;
}
```


## Notes from agent.md about the archived auth flow

- ensureAuth used chromium.launchPersistentContext() with a profile directory (~/.claude-free-bridge/profile) for persistent cookies/localStorage.
- Navigation detection: polls page.url() until `/chat` is detected (5-min timeout, configurable via timeoutMs param).
- storageState successfully saved to auth.json after detection.
- getContextOptionsFromStoredAuth() helper loads storageState into BrowserContextOptions.

## Reason for replacement

The repository owner requested the previous auth implementation be archived and replaced with a new, improved Playwright-backed auth transport that also exposes helpers to discover the active organization (lastActiveOrg cookie) and perform authenticated fetches from the stored session.

---

Archived by Copilot CLI on user's request.

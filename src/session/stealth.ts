import { BrowserContext } from 'playwright';

/**
 * Playwright launches Chromium with a handful of automation-only switches and CDP hooks that
 * Cloudflare's bot-detection (the "Verifying you are human" Turnstile challenge) checks for —
 * most visibly `navigator.webdriver === true`, which vanilla Playwright never clears even when
 * driving a real installed Chrome/Edge/Brave binary. None of that was previously being
 * suppressed, so every automated session — including ones using a real browser — presented as a
 * bot and got stuck on the challenge page. These are the standard mitigations.
 */
export const STEALTH_LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

export const STEALTH_IGNORE_DEFAULT_ARGS = ['--enable-automation'];

const INIT_SCRIPT = `
(() => {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });

  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (parameters) =>
    parameters && parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);

  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
})();
`;

export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(INIT_SCRIPT);
}

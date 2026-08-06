import { chromium, ElementHandle, Page } from 'playwright';
import { BrowserContextOptions } from 'playwright';
import { AuthInvalidError, fetchWithAuth, getLastActiveOrg, getStorageStatePath, hasStoredAuth } from '../session/auth';
import { detectInstalledBrowsers } from '../session/browsers';
import { applyStealth, STEALTH_IGNORE_DEFAULT_ARGS, STEALTH_LAUNCH_ARGS } from '../session/stealth';
import { debug, info, warn } from '../logger';

export interface SendPromptOptions {
  headed?: boolean;
  timeoutMs?: number;
  onChunk?: (chunk: string) => void;
  stream?: boolean;
}

interface ChatMessage {
  sender: string;
  created_at: string;
  content?: Array<{ text?: string; input?: string }>;
}

interface ConversationResponse {
  chat_messages: ChatMessage[];
}

const DEFAULT_SEND_TIMEOUT_MS = 120000;

// Claude's web composer is a contenteditable ProseMirror div, not a <textarea>, so
// contenteditable selectors must be tried first.
const INPUT_SELECTORS = [
  'div[contenteditable="true"][data-testid="chat-input"]',
  '[data-testid="chat-input"]',
  '[data-testid="message-input"] div[contenteditable="true"]',
  '[data-testid="message-input"] textarea',
  '[data-testid="message-input"]',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea[placeholder*="message" i]',
  'textarea',
  'input[type="text"]',
];

async function findMessageInput(page: Page, retries = 5, retryDelayMs = 1000): Promise<ElementHandle | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const selector of INPUT_SELECTORS) {
      const el = await page.$(selector).catch(() => null);
      if (el) return el;
    }
    await page.waitForTimeout(retryDelayMs);
  }
  return null;
}

function stripFences(text: string): string {
  return text.replace(/```(?:[\s\S]*?)```/g, (m) => m.replace(/```/g, ''));
}

async function findLastVisibleMessageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('div')) as HTMLElement[];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const text = candidates[i].innerText || '';
      if (text.length > 20 && /assistant|claude|model/i.test(text)) return text;
    }
    return '';
  });
}

/**
 * Loads the active account's stored cookies into a Playwright storageState so the transport
 * browser is authenticated. There is no login fallback here: unlike the old flow, an invalid or
 * missing session is never repaired by opening a browser and driving a login UI — the operator
 * must re-run auth-set-session / auth-import-browser / auth-use out of band (matching the
 * extension's model, where the extension itself never logs anyone in).
 */
async function authenticatedContextOptions(): Promise<BrowserContextOptions> {
  if (!hasStoredAuth()) {
    throw new AuthInvalidError(
      'No stored session. Run "auth-set-session <sessionKey>" or "auth-import-browser <name>" first.'
    );
  }

  const org = await getLastActiveOrg().catch(() => null);
  if (org) info('Using active session for org', org);

  try {
    await fetchWithAuth('https://claude.ai/api/account_profile');
  } catch (e) {
    if (e instanceof AuthInvalidError) throw e;
    debug('Non-auth error during auth validation', (e as Error)?.message ?? e);
  }

  return { storageState: getStorageStatePath() };
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const input = await findMessageInput(page);
  if (!input) {
    await page.screenshot({ path: 'claude-input-not-found.png', fullPage: false }).catch(() => {});
    throw new Error(
      'Could not locate the chat message input on claude.ai (selectors may be stale — UI likely changed). ' +
      'A screenshot was saved to claude-input-not-found.png for debugging.'
    );
  }

  // The composer is contenteditable, not a real <input>/<textarea>, so clear it via
  // keyboard selection instead of input.fill(), which only targets form elements.
  await input.click();
  const selectAllKey = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press('Backspace');
  await input.type(prompt, { delay: 50 });

  try {
    await input.press('Enter');
  } catch {
    const sendButton = await page.$('button[type="submit"], button[aria-label="Send"], button[aria-label="Send message"]');
    await sendButton?.click();
  }
}

/**
 * Polls claude.ai's conversation API for the assistant's reply, which is far more reliable
 * than scraping the DOM. Returns an empty string if no org/conversation could be resolved,
 * so the caller can fall back to DOM polling.
 */
async function pollConversationApi(page: Page, opts: SendPromptOptions, startTimeMs: number, timeoutMs: number): Promise<string> {
  const org = await getLastActiveOrg().catch(() => null);
  const conversationId: string | null = await page.evaluate(() => {
    const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
    return match ? match[1] : null;
  });
  if (!org || !conversationId) return '';

  info('Attempting API-driven fetch for conversation', conversationId, 'org', org);
  const pollIntervalMs = 1000;
  let lastAssistantText = '';

  while (Date.now() - startTimeMs < timeoutMs) {
    const url = `https://claude.ai/api/organizations/${org}/chat_conversations/${conversationId}?rendering_mode=messages&render_all_tools=true`;
    const res = await fetchWithAuth(url);
    const data = (res.json ?? (res.text ? JSON.parse(res.text) : null)) as ConversationResponse | null;

    if (!res.ok || !data || !Array.isArray(data.chat_messages)) {
      await page.waitForTimeout(pollIntervalMs);
      continue;
    }

    const lastAssistant = data.chat_messages
      .filter((m) => m.sender === 'assistant')
      .reduce<ChatMessage | null>((latest, msg) =>
        !latest || new Date(msg.created_at).getTime() > new Date(latest.created_at).getTime() ? msg : latest, null);

    if (lastAssistant && new Date(lastAssistant.created_at).getTime() >= startTimeMs - 5000) {
      const text = (lastAssistant.content || []).map((c) => c.text || c.input || '').join(' ');
      if (text) {
        const cleaned = stripFences(text);
        if (opts.onChunk && cleaned.length > lastAssistantText.length) {
          opts.onChunk(cleaned.slice(lastAssistantText.length));
          lastAssistantText = cleaned;
        }
        if (!opts.stream) return cleaned;
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  return opts.stream ? lastAssistantText : '';
}

async function scrapeViaDom(page: Page, opts: SendPromptOptions, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastText = '';

  while (Date.now() - start < timeoutMs) {
    const content = await findLastVisibleMessageText(page);
    if (content && content !== lastText) {
      if (opts.onChunk) {
        const cleaned = stripFences(content);
        if (cleaned.length > lastText.length) opts.onChunk(cleaned.slice(lastText.length));
      }
      lastText = content;
    }
    await page.waitForTimeout(800);
    const newContent = await findLastVisibleMessageText(page);
    if (newContent && newContent === lastText) break;
    await page.waitForTimeout(300);
  }

  const finalText = await page.evaluate(() => {
    const bubbleSelectors = ['[data-testid="assistant-message"]', '.assistant', '.message-assistant', '.chat-message--assistant'];
    for (const selector of bubbleSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length) return (elements[elements.length - 1] as HTMLElement).innerText;
    }
    const divs = Array.from(document.querySelectorAll('div')) as HTMLElement[];
    for (let i = divs.length - 1; i >= 0; i--) {
      const text = divs[i].innerText || '';
      if (text.length > 20 && /\n/.test(text)) return text;
    }
    return '';
  });

  return stripFences(finalText || lastText || '');
}

async function launchTransportBrowser(headed: boolean) {
  // Prefer a real installed browser channel over Playwright's bundled Chromium — the bundled
  // build is the one most likely to be flagged by Cloudflare's bot-detection.
  const installed = detectInstalledBrowsers().find((b) => b.kind !== 'bundled');
  const stealthOptions = {
    headless: !headed,
    args: STEALTH_LAUNCH_ARGS,
    ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
  };

  try {
    if (installed?.kind === 'channel') {
      return await chromium.launch({ ...stealthOptions, channel: installed.value });
    }
    if (installed?.kind === 'executablePath') {
      return await chromium.launch({ ...stealthOptions, executablePath: installed.value });
    }
  } catch (e) {
    warn(`Failed to launch "${installed?.label}" (${(e as Error)?.message ?? e}); falling back to bundled Chromium`);
  }
  return chromium.launch(stealthOptions);
}

export async function sendPromptViaPlaywright(prompt: string, opts: SendPromptOptions = {}): Promise<string> {
  const headed = opts.headed ?? true;
  const contextOptions = await authenticatedContextOptions();

  const browser = await launchTransportBrowser(headed);
  const context = await browser.newContext(contextOptions);
  await applyStealth(context);
  const page = await context.newPage();

  try {
    await page.goto('https://claude.ai/chat', { timeout: 60000 });
    await submitPrompt(page, prompt);

    const startTimeMs = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

    let scraped = await pollConversationApi(page, opts, startTimeMs, timeoutMs).catch((e) => {
      if (e instanceof AuthInvalidError) throw e;
      debug('API-driven retrieval failed, falling back to DOM scraping', e);
      return '';
    });

    if (!scraped) {
      scraped = await scrapeViaDom(page, opts, timeoutMs);
    }

    await page.screenshot({ path: 'claude-last.png', fullPage: false }).catch(() => {});
    return scraped || 'No assistant text could be scraped.';
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

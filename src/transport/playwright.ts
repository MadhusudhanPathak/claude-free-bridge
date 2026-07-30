import { chromium } from 'playwright';
import { getContextOptionsFromStoredAuth, ensureAuth, getLastActiveOrg, fetchWithAuth, getContextOptionsForOrg } from '../session/auth';
import { info, warn, debug, error } from '../logger';

async function findMessageInput(page: any) {
  // Try several known selectors; return first matching locator
  const selectors = [
    '[data-testid="message-input"] textarea',
    '[data-testid="message-input"]',
    'textarea[placeholder*="message"]',
    'textarea',
    'input[type="text"]'
  ];
  for (const s of selectors) {
    try {
      const el = await page.$(s);
      if (el) return el;
    } catch {}
  }
  return null;
}

function stripFences(text: string) {
  return text.replace(/```(?:[\s\S]*?)```/g, (m) => m.replace(/```/g, ''));
}

export async function sendPromptViaPlaywright(prompt: string, opts: { headed?: boolean; timeoutMs?: number } = {}): Promise<string> {
  const headed = opts.headed ?? true;

  // Ensure auth exists or prompt user to login
  if (!getContextOptionsFromStoredAuth()) {
    await ensureAuth(true, 0);
  }
  let ctxOpts = getContextOptionsFromStoredAuth();

  // Try to use org-specific profile if available
  try {
    const org = await getLastActiveOrg();
    if (org) {
      const orgOpts = getContextOptionsForOrg(org);
      if (orgOpts) {
        ctxOpts = orgOpts;
        info('Using profile for org', org);
      }
    }
  } catch (e) {
    // ignore
  }

  // Verify stored auth quickly by fetching account_profile; if invalid, prompt re-auth
  try {
    if (ctxOpts) {
      try {
        await fetchWithAuth('https://claude.ai/api/account_profile');
      } catch (e: any) {
        if (e?.code === 'E_AUTH_INVALID') {
          warn('Stored auth invalid — launching interactive re-auth');
          await ensureAuth(headed, 0);
          ctxOpts = getContextOptionsFromStoredAuth();
        } else {
          // Non-auth error - ignore here
          debug('Non-auth error during auth validation', e?.message ?? e);
        }
      }
    }
  } catch (e) {
    // ignore
    debug('Error validating auth', e);
  }

  const browser = await chromium.launch({ headless: !headed });
  const context = ctxOpts ? await browser.newContext(ctxOpts) : await browser.newContext();
  const page = await context.newPage();
  try {
    // Open chat page (resume if storageState contains an open chat)
    await page.goto('https://claude.ai/chat', { timeout: 60000 });

    const input = await findMessageInput(page);
    if (!input) {
      // Fallback: let user interact and then try again
      console.warn('Could not find message input automatically. Please focus the browser and ensure chat is open.');
      await page.bringToFront();
      // Wait a short while for manual focus
      await page.waitForTimeout(3000);
    }

    // Type prompt realistically
    if (input) {
      await input.fill('');
      await input.type(String(prompt), { delay: 50 });
      // Try pressing Enter or clicking send
      try {
        await input.press('Enter');
      } catch {
        // fallback: click the send button if exists
        const sendBtn = await page.$('button[type="submit"], button[aria-label="Send"]');
        if (sendBtn) await sendBtn.click();
      }
    }

    // Attempt API-driven retrieval if possible (more deterministic than DOM scraping)
    const startTimeMs = Date.now();
    const timeout = opts.timeoutMs ?? 120000;
    let scraped = '';
    try {
      const org = await getLastActiveOrg();
      let conversationId = await page.evaluate(() => {
        const m = window.location.pathname.match(/\/chat\/([^/?]+)/);
        return m ? m[1] : null;
      });

      if (org && conversationId) {
        info('Attempting API-driven fetch for conversation', conversationId, 'org', org);
        const pollInterval = 1000;
        while (Date.now() - startTimeMs < timeout) {
          try {
            const url = `https://claude.ai/api/organizations/${org}/chat_conversations/${conversationId}?rendering_mode=messages&render_all_tools=true`;
            const res = await fetchWithAuth(url);
            if (!res || !res.ok) {
              // wait and retry
              await page.waitForTimeout(pollInterval);
              continue;
            }
            const data = res.json || (res.text ? JSON.parse(res.text) : null);
            if (!data || !Array.isArray(data.chat_messages)) {
              await page.waitForTimeout(pollInterval);
              continue;
            }

            // Find last assistant message newer than startTimeMs
            let lastAssistant = null;
            for (const msg of data.chat_messages) {
              if (msg.sender === 'assistant') {
                if (!lastAssistant || new Date(msg.created_at).getTime() > new Date(lastAssistant.created_at).getTime()) {
                  lastAssistant = msg;
                }
              }
            }

            if (lastAssistant) {
              const created = new Date(lastAssistant.created_at).getTime();
              // If created after prompt start (little tolerance), treat as response
              if (created >= startTimeMs - 5000) {
                // Extract text content (conservative)
                const text = (lastAssistant.content || []).map(c => c.text || c.input || '').join(' ');
                if (text && text.length > 0) {
                  scraped = stripFences(text);
                  // Heuristic for stability: break once we have non-empty text
                  break;
                }
              }
            }

          } catch (e) {
            debug('API-driven polling error', e?.message ?? e);
          }
          await page.waitForTimeout(pollInterval);
        }
      }
    } catch (e) {
      debug('API-driven retrieval failed, falling back to DOM scraping', e);
    }

    if (!scraped) {
      // Fallback: DOM polling
      const start = Date.now();
      let lastText = '';
      while (Date.now() - start < timeout) {
        try {
          const content = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('div'));
            for (let i = candidates.length - 1; i >= 0; i--) {
              const el = candidates[i] as HTMLElement;
              if (!el) continue;
              const html = el.innerText || '';
              if (html.length > 20 && /assistant|claude|model|assistant/i.test(html)) {
                return html;
              }
            }
            return '';
          });
          if (content && content !== lastText) {
            lastText = content;
          }
          await page.waitForTimeout(800);
          const newContent = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('div'));
            for (let i = candidates.length - 1; i >= 0; i--) {
              const el = candidates[i] as HTMLElement;
              if (!el) continue;
              const html = el.innerText || '';
              if (html.length > 20 && /assistant|claude|model|assistant/i.test(html)) {
                return html;
              }
            }
            return '';
          });
          if (newContent && newContent === lastText) break;
        } catch (e) {
          // ignore and continue polling
        }
        await page.waitForTimeout(300);
      }

      // DOM extract
      scraped = await page.evaluate(() => {
        function findLastText() {
          const bubbleSelectors = [
            '[data-testid="assistant-message"]',
            '.assistant',
            '.message-assistant',
            '.chat-message--assistant'
          ];
          for (const sel of bubbleSelectors) {
            const el = document.querySelectorAll(sel);
            if (el && el.length) return (el[el.length - 1] as HTMLElement).innerText;
          }
          const divs = Array.from(document.querySelectorAll('div')) as HTMLElement[];
          for (let i = divs.length - 1; i >= 0; i--) {
            const t = divs[i].innerText || '';
            if (t.length > 20 && /\n/.test(t)) return t;
          }
          return '';
        }
        return findLastText();
      });

      scraped = stripFences(scraped || lastText || '');
    }

    // Save a screenshot for debugging
    try { await page.screenshot({ path: 'claude-last.png', fullPage: false }); } catch {}

    await page.close();
    await context.close();
    await browser.close();
    return scraped || 'No assistant text could be scraped.';
  } catch (err) {
    try { await page.close(); } catch {};
    try { await context.close(); } catch {};
    try { await browser.close(); } catch {};
    throw err;
  }
}

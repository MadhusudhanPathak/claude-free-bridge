// Runs inside claude.ai tabs. Executes jobs from the service worker against claude.ai's API
// (see claude/) and streams results back over a port.
import { toBridgeError } from '../../shared/src/errors';
import { getAccount } from './claude/account';
import { send } from './claude/completion';
import { createConversation, deleteConversation, getConversation, listConversations } from './claude/conversations';
import { JOB_PORT, type TabReply, type TabRun } from './messages';

declare global {
  var __cfbContentLoaded: boolean | undefined;
}

function run(msg: TabRun, onChunk: (text: string) => void, signal: AbortSignal): Promise<unknown> {
  switch (msg.op) {
    case 'account':
      return getAccount(msg.params.orgHint || msg.orgId || undefined);
    case 'send':
      return send(msg.orgId, msg.apiChats, msg.params, onChunk, signal);
    case 'listConversations':
      return listConversations(msg.orgId, msg.params);
    case 'getConversation':
      return getConversation(msg.orgId, msg.params.id);
    case 'createConversation':
      return createConversation(msg.orgId, msg.params);
    case 'deleteConversation':
      return deleteConversation(msg.orgId, msg.params.id);
  }
}

// The service worker may inject this script into an already-open tab; only set up once.
if (!globalThis.__cfbContentLoaded) {
  globalThis.__cfbContentLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'cfb-ping') sendResponse({ ok: true });
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== JOB_PORT) return;
    const ac = new AbortController();
    let open = true;
    port.onDisconnect.addListener(() => {
      open = false;
      ac.abort();
    });
    const post = (m: TabReply) => {
      if (!open) return;
      try {
        port.postMessage(m);
      } catch {
        open = false;
      }
    };

    port.onMessage.addListener(async (msg: TabRun) => {
      if (msg?.type !== 'run') return;
      try {
        const data = await run(msg, (text) => post({ type: 'chunk', text }), ac.signal);
        post({ type: 'result', ok: true, data });
      } catch (e) {
        post({ type: 'result', ok: false, error: toBridgeError(e) });
      }
    });
  });

  chrome.runtime.sendMessage({ type: 'cfb-content-ready' }).catch(() => undefined);
}

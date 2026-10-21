// Service worker: connects to the helper, runs jobs in the claude.ai worker tab, tracks the
// claude.ai login, and feeds the side panel.
import { BridgeFailure, toBridgeError } from '../../shared/src/errors';
import type { ExtensionSettings, ExtensionStatus, Op, OpMap, SendParams, SendResult } from '../../shared/src/protocol';
import { shorten } from '../../shared/src/text';
import { HelperLink } from './helperLink';
import { type ActivityEntry, PANEL_PORT, type PanelCommand, type PanelEvent, type PanelState, type TabOp } from './messages';
import * as store from './store';
import { runInTab } from './tabRunner';
import { getWorkerTab, NoWorkerTabError } from './workerTab';

const CLAUDE = 'https://claude.ai';
const ALARM = 'cfb-reconnect';

const panels = new Set<chrome.runtime.Port>();
let activeJobs = 0;

const link = new HelperLink({
  status: currentStatus,
  run: (op, params, onChunk, signal) => runJob('helper', op, params, onChunk, signal),
  changed: () => {
    void broadcast();
    void updateBadge();
  },
});

// Login / status

async function currentStatus(): Promise<ExtensionStatus> {
  const login = await store.getCachedLogin();
  return { loggedIn: login.loggedIn, account: login.account, settings: await store.getSettings() };
}

async function cookie(name: string): Promise<string | null> {
  const c = await chrome.cookies.get({ url: CLAUDE, name }).catch(() => null);
  return c?.value ?? null;
}

async function orgHint(settings?: ExtensionSettings): Promise<string> {
  const s = settings ?? (await store.getSettings());
  return s.orgId || (await cookie('lastActiveOrg')) || '';
}

async function setLogin(login: store.CachedLogin): Promise<void> {
  await store.setCachedLogin(login);
  link.sendStatus(await currentStatus());
  void broadcast();
  void updateBadge();
}

let refreshing: Promise<void> | null = null;

/** Re-reads login + account. With openTab, opens a claude.ai tab if needed to read the account. */
function refreshLogin(openTab: boolean): Promise<void> {
  if (refreshing && !openTab) return refreshing;
  const run = async () => {
    if (!(await cookie('sessionKey'))) return setLogin({ loggedIn: false, account: null });
    const cached = await store.getCachedLogin();
    let tabId: number;
    try {
      tabId = await getWorkerTab(openTab);
    } catch {
      // No claude.ai tab to ask; the cookie says we're logged in, account details stay as they were.
      return setLogin({ loggedIn: true, account: cached.account });
    }
    try {
      const account = await runInTab(tabId, 'account', { orgHint: await orgHint() }, '');
      await setLogin({ loggedIn: true, account });
    } catch (e) {
      if (toBridgeError(e).code === 'AUTH_INVALID') await setLogin({ loggedIn: false, account: null });
      else await setLogin({ loggedIn: true, account: cached.account });
    }
  };
  const prev = refreshing ?? Promise.resolve();
  const p: Promise<void> = prev
    .then(run, run)
    .catch((e) => console.warn('Login refresh failed', e))
    .finally(() => {
      if (refreshing === p) refreshing = null;
    });
  refreshing = p;
  return p;
}

// Jobs

function describe(op: Op, params: unknown, result?: unknown): string {
  if (op === 'send') {
    const p = params as SendParams;
    const label = p.newChatName ?? shorten(p.text, 60);
    return result ? `${label} → ${(result as SendResult).text.length} chars` : label;
  }
  if (op === 'getConversation' || op === 'deleteConversation') return (params as { id: string }).id;
  return '';
}

async function runJob<K extends Op>(
  source: ActivityEntry['source'],
  op: K,
  params: OpMap[K]['params'],
  onChunk: (t: string) => void,
  signal: AbortSignal
): Promise<OpMap[K]['result']> {
  activeJobs++;
  void updateBadge();
  void broadcast();
  const started = Date.now();
  try {
    let result: unknown;
    if (op === 'status') {
      await refreshLogin(true);
      result = await currentStatus();
    } else {
      if (!(await cookie('sessionKey'))) {
        throw new BridgeFailure('AUTH_INVALID', 'This browser is not logged in to claude.ai');
      }
      let tabId: number;
      try {
        tabId = await getWorkerTab(true);
      } catch (e) {
        throw new BridgeFailure('NO_WORKER_TAB', e instanceof NoWorkerTabError ? e.message : `Could not open a claude.ai tab: ${String(e)}`);
      }
      const settings = await store.getSettings();
      const login = await store.getCachedLogin();
      const orgId = settings.orgId || login.account?.org.id || (await orgHint(settings));
      result = await runInTab(tabId, op as TabOp, params as never, orgId, { apiChats: settings.apiChats, onChunk, signal });
      if (!login.account) void refreshLogin(false);
    }
    void store.addActivity({ at: started, source, op, ok: true, ms: Date.now() - started, detail: describe(op, params, result) });
    return result as OpMap[K]['result'];
  } catch (e) {
    const err = toBridgeError(e);
    if (err.code === 'AUTH_INVALID') await setLogin({ loggedIn: false, account: null });
    void store.addActivity({ at: started, source, op, ok: false, ms: Date.now() - started, detail: `${describe(op, params)} — ${err.message}` });
    throw e;
  } finally {
    activeJobs--;
    void updateBadge();
    void broadcast();
  }
}

// Side panel

async function panelState(): Promise<PanelState> {
  return {
    version: chrome.runtime.getManifest().version,
    helper: { state: link.state, message: link.message, url: link.url, paired: link.paired },
    status: await currentStatus(),
    activity: await store.getActivity(),
    activeJobs,
  };
}

function post(port: chrome.runtime.Port, ev: PanelEvent): void {
  try {
    port.postMessage(ev);
  } catch {
    panels.delete(port);
  }
}

async function broadcast(): Promise<void> {
  if (!panels.size) return;
  const state = await panelState();
  for (const p of panels) post(p, { type: 'state', state });
}

const testRuns = new WeakMap<chrome.runtime.Port, AbortController>();

async function onPanelCommand(port: chrome.runtime.Port, c: PanelCommand): Promise<void> {
  switch (c.cmd) {
    case 'saveConnection': {
      // Empty fields mean "keep what's saved".
      const token = c.token.trim();
      const url = c.url.trim();
      await store.setConnection({ enabled: true, ...(url ? { helperUrl: url } : {}), ...(token ? { pairingToken: token } : {}) });
      await link.reconnect();
      break;
    }
    case 'disconnect':
      await link.disconnect();
      break;
    case 'reconnect':
      await store.setConnection({ enabled: true });
      await link.reconnect();
      break;
    case 'saveSettings': {
      const before = await store.getSettings();
      const models = [...new Set(c.settings.models.map((m) => m.trim()).filter(Boolean))];
      await store.setSettings({ apiChats: c.settings.apiChats === 'delete' ? 'delete' : 'keep', models, orgId: c.settings.orgId });
      link.sendStatus(await currentStatus());
      if (before.orgId !== c.settings.orgId) await refreshLogin(false);
      break;
    }
    case 'refreshAccount':
      await refreshLogin(true);
      break;
    case 'openClaude':
      await chrome.tabs.create({ url: `${CLAUDE}/new` });
      break;
    case 'testSend': {
      testRuns.get(port)?.abort();
      const ac = new AbortController();
      testRuns.set(port, ac);
      runJob('panel', 'send', { ...c.params, source: 'panel' }, (text) => post(port, { type: 'testChunk', text }), ac.signal).then(
        (result) => post(port, { type: 'testDone', result }),
        (e) => post(port, { type: 'testError', error: toBridgeError(e) })
      );
      break;
    }
    case 'testCancel':
      testRuns.get(port)?.abort();
      break;
    case 'clearActivity':
      await store.clearActivity();
      break;
  }
  await broadcast();
}

// Toolbar badge

async function updateBadge(): Promise<void> {
  const login = await store.getCachedLogin();
  let text = '';
  let color = '#6b7280';
  if (!login.loggedIn) {
    text = '!';
    color = '#c0392b';
  } else if (link.state !== 'connected') {
    text = link.state === 'off' || link.state === 'unpaired' || link.state === 'wrong-code' ? '' : 'off';
  } else if (activeJobs > 0) {
    text = String(activeJobs);
    color = '#2e7d32';
  }
  await chrome.action.setBadgeText({ text }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
}

// Event wiring (listeners must be registered synchronously at startup)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  panels.add(port);
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    testRuns.get(port)?.abort();
  });
  port.onMessage.addListener((c: PanelCommand) => void onPanelCommand(port, c).catch((e) => console.error('Panel command failed', e)));
  void panelState().then((state) => post(port, { type: 'state', state }));
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'cfb-content-ready') {
    void store.getCachedLogin().then((l) => {
      if (!l.loggedIn || !l.account) void refreshLogin(false);
    });
  }
  return false;
});

let cookieTimer: ReturnType<typeof setTimeout> | undefined;
chrome.cookies.onChanged.addListener(({ cookie: c }) => {
  if (c.name !== 'sessionKey' || !c.domain.endsWith('claude.ai')) return;
  // Logging in/out replaces the cookie in several steps; react once things settle.
  clearTimeout(cookieTimer);
  cookieTimer = setTimeout(() => void refreshLogin(false), 1500);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void link.connect();
});

const PANEL_AS_TAB = 'sidepanel.html?tab=1';

chrome.action.onClicked.addListener(() => {
  // Only fires in browsers without the side panel API (e.g. Opera): open the panel as a tab.
  void chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_AS_TAB) });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // First install: show the setup steps right away.
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_AS_TAB) });
});

async function init(): Promise<void> {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  }
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  const login = await store.getCachedLogin();
  if (!login.account) await refreshLogin(false);
  await updateBadge();
  await link.connect();
}

void init();

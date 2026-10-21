// Finds (or opens) the claude.ai tab whose content script runs jobs, and makes sure the
// content script is actually there to talk to.

const CLAUDE_URL = 'https://claude.ai/*';
const NEW_TAB_URL = 'https://claude.ai/new';
const LOAD_TIMEOUT_MS = 45_000;

let pending: { promise: Promise<number>; open: boolean } | null = null;

export class NoWorkerTabError extends Error {}

async function storedTabId(): Promise<number | undefined> {
  const { workerTabId } = await chrome.storage.session.get('workerTabId');
  return typeof workerTabId === 'number' ? workerTabId : undefined;
}

async function pickExistingTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: CLAUDE_URL });
  if (!tabs.length) return undefined;
  const stored = await storedTabId();
  return (
    tabs.find((t) => t.id === stored) ??
    tabs.find((t) => !t.discarded && t.status === 'complete') ??
    tabs.find((t) => !t.discarded) ??
    tabs[0]
  );
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new NoWorkerTabError('The claude.ai tab took too long to load'));
    }, LOAD_TIMEOUT_MS);
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === 'complete') listener(tabId, { status: 'complete' });
      },
      () => undefined
    );
  });
}

async function contentScriptAlive(tabId: number): Promise<boolean> {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'cfb-ping' });
    return r?.ok === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  if (await contentScriptAlive(tabId)) return;
  // Tabs opened before the extension was installed/updated don't have it yet.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  for (let i = 0; i < 10; i++) {
    if (await contentScriptAlive(tabId)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new NoWorkerTabError('Could not reach the bridge script in the claude.ai tab');
}

async function prepare(open: boolean): Promise<number> {
  let tab = await pickExistingTab();
  if (!tab) {
    if (!open) throw new NoWorkerTabError('No claude.ai tab is open');
    tab = await chrome.tabs.create({ url: NEW_TAB_URL, pinned: true, active: false });
  }
  const tabId = tab.id!;
  await chrome.storage.session.set({ workerTabId: tabId });

  if (tab.discarded) await chrome.tabs.reload(tabId);
  await waitForLoad(tabId);
  // Keep the browser's memory saver from unloading the tab while the bridge relies on it.
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
  await ensureContentScript(tabId);
  return tabId;
}

/**
 * Returns a ready claude.ai tab id. With `open: true`, opens a pinned background tab if none
 * exists; otherwise throws NoWorkerTabError.
 */
export function getWorkerTab(open: boolean): Promise<number> {
  // Share one in-flight lookup so concurrent jobs don't open several tabs.
  if (pending && (pending.open || !open)) return pending.promise;
  const before = pending?.promise.catch(() => undefined) ?? Promise.resolve();
  const promise = before
    .then(() => prepare(open))
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { promise, open };
  return promise;
}

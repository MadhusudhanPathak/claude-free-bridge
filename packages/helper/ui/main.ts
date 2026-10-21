// Control Center: the window the app opens. Setup checklist, settings for other apps, playground.
import { initApps, renderApps } from './apps';
import { $, copy } from './dom';
import { focusPlayground, initPlayground, loadModels } from './playground';
import { app, ApiError, getJson, session, uiRequest, type BridgeStatus, type Session } from './session';

type Tab = 'setup' | 'apps' | 'playground';

const POLL_MS = 3000;
const TOKEN_KEY = 'cfb-ui-token';

let userPickedTab = false;
let firstStatus = true;
let stopped = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** The app opens this page as /#ui=<token>. Keep it for reloads, and take it out of the address bar. */
function readUiToken(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('ui');
  try {
    if (fromHash) sessionStorage.setItem(TOKEN_KEY, fromHash);
    if (location.hash) history.replaceState(null, '', location.pathname);
    return fromHash || sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return fromHash || '';
  }
}

function lock(): void {
  for (const id of ['tab-setup', 'tab-apps', 'tab-playground']) $(id).hidden = true;
  document.querySelector<HTMLElement>('.tabs')!.hidden = true;
  $('locked').hidden = false;
  setStatus('idle', 'Locked');
}

function showTab(tab: Tab, byUser = false): void {
  if (byUser) userPickedTab = true;
  for (const t of ['setup', 'apps', 'playground'] as Tab[]) {
    $(`tab-${t}`).hidden = t !== tab;
    $(`tab-btn-${t}`).setAttribute('aria-selected', String(t === tab));
  }
  if (tab === 'playground') focusPlayground();
}

function setStatus(kind: 'ok' | 'warn' | 'bad' | 'idle', text: string): void {
  $('status-dot').className = `dot ${kind === 'idle' ? '' : kind}`;
  $('status-text').textContent = text;
}

function banner(text: string | null): void {
  $('banner').hidden = !text;
  $('banner').textContent = text ?? '';
}

function markStep(id: string, done: boolean, current: boolean, note?: string): void {
  const step = $(id);
  step.classList.toggle('done', done);
  step.classList.toggle('current', !done && current);
  const noteEl = step.querySelector<HTMLElement>('.done-note');
  if (noteEl) {
    noteEl.hidden = !note;
    noteEl.textContent = note ?? '';
  }
}

function renderStatus(s: BridgeStatus): void {
  const connected = s.extension.connected;
  const browser = s.extension.browser ?? 'your browser';
  const loggedIn = connected && s.loggedIn === true;
  const who = s.account ? `${s.account.email ?? s.account.name ?? 'your account'} (${s.account.org.plan})` : 'your account';

  if (!connected) setStatus('warn', 'Waiting for the browser extension');
  else if (!loggedIn) setStatus('bad', `Log in to claude.ai in ${browser}`);
  else {
    const queue = s.queue.waitingForLogin ? ' · waiting for login' : s.queue.length ? ` · ${s.queue.length} in queue` : '';
    setStatus('ok', `Ready · ${browser} · ${who}${queue}`);
  }

  // A recent failed pairing attempt means the extension is installed but has the wrong code.
  const rejected = !connected && s.extension.lastRejection && Date.now() - s.extension.lastRejection.at < 120_000;
  markStep('step-ext', connected || !!rejected, !connected && !rejected, connected ? `✓ Installed in ${browser}` : rejected ? '✓ Installed' : undefined);
  markStep(
    'step-pair',
    connected,
    !connected,
    connected
      ? `✓ Connected to ${browser}`
      : rejected
        ? 'The extension tried to connect with a wrong or old pairing code. Copy the code above and paste it into the panel again.'
        : undefined
  );
  $('pair-done').classList.toggle('warning', !!rejected && !connected);
  markStep('step-login', loggedIn, connected && !loggedIn, loggedIn ? `✓ Logged in as ${who}` : undefined);

  const ready = connected && loggedIn;
  $('ready').hidden = !ready;
  if (firstStatus && !userPickedTab) showTab(ready ? 'playground' : 'setup');
  firstStatus = false;
}

async function poll(): Promise<void> {
  clearTimeout(pollTimer);
  if (stopped) return;
  try {
    renderStatus(await getJson<BridgeStatus>('/bridge/status'));
    banner(null);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // Keys were reset in another window; pick up the new ones.
      await loadSession().catch(() => undefined);
    } else {
      setStatus('bad', 'Not running');
      banner("Can't reach Claude Free Bridge. It may have been closed. Start the app again to continue.");
    }
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

function renderSession(s: Session): void {
  $('version').textContent = `v${s.version}`;
  $('pair-code').textContent = s.pairingToken;
  $('ext-dir').textContent = s.extensionDir ?? 'Not found next to the app. Use the "extension" folder from the download.';
  $('open-ext-dir').hidden = !s.extensionDir;
  $('quit').hidden = !s.canQuit;
  renderApps(s);
}

async function loadSession(): Promise<void> {
  app.session = await uiRequest<Session>('GET', '/ui/session');
  renderSession(app.session);
}

function wire(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.addEventListener('click', () => showTab(b.dataset.tab as Tab, true));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-goto]')) {
    b.addEventListener('click', () => showTab(b.dataset.goto as Tab, true));
  }

  // Copy buttons: literal text, another element's text, or a secret from the session.
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-copy-text], [data-copy-from], [data-copy-secret]');
    if (!b) return;
    if (b.dataset.copyText) void copy(b.dataset.copyText);
    else if (b.dataset.copyFrom) void copy($(b.dataset.copyFrom).textContent ?? '');
    else if (b.dataset.copySecret === 'apiKey') void copy(session().apiKey, 'API key copied');
    else if (b.dataset.copySecret === 'pairingToken') void copy(session().pairingToken, 'Pairing code copied');
  });

  $('open-ext-dir').addEventListener('click', () => {
    uiRequest('POST', '/ui/open-extension-folder').catch((err) => banner(`Couldn't open the folder: ${(err as Error).message}`));
  });

  $('quit').addEventListener('click', async () => {
    if (!confirm('Stop Claude Free Bridge?\n\nYour apps and the extension disconnect until you start it again.')) return;
    try {
      await uiRequest('POST', '/ui/quit');
    } catch {
      // it may already be gone
    }
    stopped = true;
    clearTimeout(pollTimer);
    setStatus('idle', 'Stopped');
    banner('Claude Free Bridge has stopped. You can close this window.');
  });

  initApps((s) => {
    renderSession(s);
    void loadModels();
  });
  initPlayground(() => void poll());
}

async function boot(): Promise<void> {
  app.uiToken = readUiToken();
  if (!app.uiToken) return lock();
  try {
    await loadSession();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return lock();
    setStatus('bad', 'Not running');
    banner("Can't reach Claude Free Bridge. Start the app again to continue.");
    return;
  }
  wire();
  showTab('setup');
  void poll();
}

void boot();

// The side panel UI. It holds no logic of its own: it renders the service worker's state and
// sends it commands over the panel port.
import type { ApiChats } from '../../../shared/src/protocol';
import { PANEL_PORT, type PanelCommand, type PanelEvent, type PanelState } from '../messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let port: chrome.runtime.Port;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let state: PanelState | null = null;
let formsFilled = false;
let lastTestChat: string | null = null;

function send(c: PanelCommand): void {
  try {
    port.postMessage(c);
  } catch {
    connect();
    port.postMessage(c);
  }
}

function connect(): void {
  clearTimeout(reconnectTimer);
  const p = chrome.runtime.connect({ name: PANEL_PORT });
  port = p;
  p.onMessage.addListener(onEvent);
  // The service worker can restart; reconnect to the new one (unless a newer port exists already).
  p.onDisconnect.addListener(() => {
    if (port === p) reconnectTimer = setTimeout(connect, 500);
  });
}

function setDot(id: string, kind: 'ok' | 'warn' | 'bad' | 'idle'): void {
  $(id).className = `dot ${kind === 'idle' ? '' : kind}`;
}

function render(s: PanelState): void {
  $('version').textContent = `v${s.version}`;

  // The app (helper) connection
  const h = s.helper;
  const needsPairing = h.state === 'unpaired' || h.state === 'wrong-code';
  $('pair-card').hidden = !needsPairing;
  $('pair-error').hidden = h.state !== 'wrong-code';
  $('pair-error').textContent = h.state === 'wrong-code' ? h.message : '';
  setDot('helper-dot', h.state === 'connected' ? 'ok' : h.state === 'connecting' ? 'warn' : h.state === 'off' || h.state === 'unpaired' ? 'idle' : 'bad');
  $('helper-text').textContent = h.state === 'unpaired' ? 'Not connected yet' : h.message || h.state;
  $('reconnect').hidden = !(h.state === 'off' || h.state === 'rejected' || h.state === 'disconnected');

  // claude.ai login
  const st = s.status;
  const a = st.account;
  setDot('login-dot', !st.loggedIn ? 'bad' : a ? 'ok' : 'warn');
  $('login-text').textContent = !st.loggedIn
    ? 'Not logged in. Log in at claude.ai in this browser.'
    : a
      ? `${a.email ?? a.name ?? 'Logged in'} · ${a.org.name} (${a.org.plan})`
      : 'Logged in. Account details load once a claude.ai tab is open.';
  $('open-claude').hidden = st.loggedIn;

  // Jobs
  setDot('jobs-dot', s.activeJobs ? 'ok' : 'idle');
  $('jobs-text').textContent = s.activeJobs ? `${s.activeJobs} running` : 'Idle';

  // Org list (keep the user's selection)
  const org = $<HTMLSelectElement>('org');
  const current = formsFilled ? org.value : st.settings.orgId;
  const orgs = a?.orgs ?? [];
  org.replaceChildren(new Option('Automatic (last used on claude.ai)', ''), ...orgs.map((o) => new Option(`${o.name} (${o.plan})`, o.id)));
  if (current && !orgs.some((o) => o.id === current)) org.append(new Option(current, current));
  org.value = current;

  if (!formsFilled) {
    $<HTMLInputElement>('helper-url').value = h.url;
    $<HTMLInputElement>('pairing-token').placeholder = h.paired ? '(saved — paste a new one to change)' : 'cfbpair-…';
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name="api-chats"]')) r.checked = r.value === st.settings.apiChats;
    $<HTMLTextAreaElement>('models').value = st.settings.models.join('\n');
    formsFilled = true;
  }

  // Activity
  const list = $('activity');
  list.replaceChildren(
    ...s.activity.map((e) => {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'muted';
      time.textContent = new Date(e.at).toLocaleTimeString();
      const op = document.createElement('span');
      op.className = 'op';
      op.textContent = `${e.op}${e.source === 'panel' ? ' (test)' : ''}`;
      const res = document.createElement('span');
      res.className = e.ok ? 'ok' : 'fail';
      res.textContent = `${e.ok ? 'ok' : 'failed'} · ${(e.ms / 1000).toFixed(1)} s`;
      li.append(time, op, res);
      if (e.detail) {
        const d = document.createElement('span');
        d.className = 'detail';
        d.textContent = e.detail;
        li.append(d);
      }
      return li;
    })
  );
  $('activity-empty').hidden = s.activity.length > 0;
}

function testRunning(running: boolean): void {
  $<HTMLButtonElement>('test-send').disabled = running;
  $('test-stop').hidden = !running;
}

function onEvent(ev: PanelEvent): void {
  const out = $<HTMLPreElement>('test-output');
  switch (ev.type) {
    case 'state':
      state = ev.state;
      render(ev.state);
      break;
    case 'testChunk':
      out.textContent += ev.text;
      out.scrollTop = out.scrollHeight;
      break;
    case 'testDone': {
      testRunning(false);
      if (!out.textContent) out.textContent = ev.result.text;
      lastTestChat = ev.result.conversationId;
      const link = $<HTMLAnchorElement>('test-link');
      link.href = ev.result.url;
      link.hidden = false;
      break;
    }
    case 'testError':
      testRunning(false);
      out.hidden = false;
      out.classList.add('error');
      out.textContent += `${out.textContent ? '\n\n' : ''}Error (${ev.error.code}): ${ev.error.message}`;
      break;
  }
}

function pairWithInput(): void {
  const input = $<HTMLInputElement>('pair-input');
  const token = input.value.trim();
  const error = $('pair-error');
  if (!token) {
    error.textContent = 'Paste the pairing code from the Claude Free Bridge app first.';
    error.hidden = false;
    input.focus();
    return;
  }
  send({ cmd: 'saveConnection', url: state?.helper.url ?? '', token });
  input.value = '';
}

$('pair-connect').addEventListener('click', pairWithInput);
$('pair-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pairWithInput();
});
$('reconnect').addEventListener('click', () => send({ cmd: 'reconnect' }));

$('connect').addEventListener('click', () => {
  // An empty pairing code keeps the saved one.
  const token = $<HTMLInputElement>('pairing-token');
  send({ cmd: 'saveConnection', url: $<HTMLInputElement>('helper-url').value, token: token.value });
  token.value = '';
});

$('disconnect').addEventListener('click', () => send({ cmd: 'disconnect' }));
$('open-claude').addEventListener('click', () => send({ cmd: 'openClaude' }));
$('refresh-account').addEventListener('click', () => send({ cmd: 'refreshAccount' }));
$('clear-activity').addEventListener('click', () => send({ cmd: 'clearActivity' }));

$('save-settings').addEventListener('click', () => {
  const apiChats = (document.querySelector<HTMLInputElement>('input[name="api-chats"]:checked')?.value ?? 'keep') as ApiChats;
  send({
    cmd: 'saveSettings',
    settings: {
      apiChats,
      models: $<HTMLTextAreaElement>('models').value.split('\n'),
      orgId: $<HTMLSelectElement>('org').value,
    },
  });
  const saved = $('settings-saved');
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});

$('test-send').addEventListener('click', () => {
  const text = $<HTMLTextAreaElement>('test-input').value.trim();
  if (!text) return;
  const out = $<HTMLPreElement>('test-output');
  out.hidden = false;
  out.classList.remove('error');
  out.textContent = '';
  $('test-link').hidden = true;
  testRunning(true);
  const conversationId = $<HTMLInputElement>('test-continue').checked && lastTestChat ? lastTestChat : undefined;
  send({ cmd: 'testSend', params: { text, conversationId } });
});

$('test-stop').addEventListener('click', () => send({ cmd: 'testCancel' }));

$('test-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('test-send').click();
});

// Opened as a tab (first install, or browsers without a side panel): explain how to get back here.
$('tab-tip').hidden = !new URLSearchParams(location.search).has('tab');

connect();

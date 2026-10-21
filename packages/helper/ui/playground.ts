// Playground tab: chat through the OpenAI, Anthropic and Bridge APIs, exactly as an app would.
import type { ConversationDetail, ConversationSummary, SendResult } from '../../shared/src/protocol';
import { readSseEvents } from '../../shared/src/sse';
import { $ } from './dom';
import { buildRequest, DEFAULT_MODEL, fullText, type Mode, MODES, readEvent } from './playgroundApi';
import { apiHeaders, ApiError, errorFrom, getJson } from './session';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  error?: boolean;
  pending?: boolean;
  meta?: string;
}

const MAX_RAW = 200_000;
const PREFS_KEY = 'cfb-playground';

const MODE_HINTS: Record<Mode, string> = {
  openai: 'Like an OpenAI app (POST /v1/chat/completions). The whole conversation is resent each time, and each request starts a new claude.ai chat.',
  anthropic: 'Like an Anthropic app (POST /v1/messages). The whole conversation is resent each time, and each request starts a new claude.ai chat.',
  bridge: 'Your real claude.ai chats: pick one to continue it, or start a new one. Messages show up in claude.ai too.',
};

const els = {
  modeButtons: [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')],
  modeHint: $('mode-hint'),
  model: $<HTMLSelectElement>('model'),
  stream: $<HTMLInputElement>('stream'),
  system: $<HTMLTextAreaElement>('system'),
  systemSection: $('system-section'),
  chatsSection: $('chats-section'),
  chats: $<HTMLUListElement>('chats'),
  chatsRefresh: $<HTMLButtonElement>('chats-refresh'),
  newChat: $<HTMLButtonElement>('new-chat'),
  chatTitle: $('chat-title'),
  chatLink: $<HTMLAnchorElement>('chat-link'),
  clear: $<HTMLButtonElement>('clear'),
  messages: $('messages'),
  empty: $('empty'),
  composer: $<HTMLFormElement>('composer'),
  input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('send'),
  stop: $<HTMLButtonElement>('stop'),
  rawReq: $('raw-req'),
  rawRes: $('raw-res'),
};

const state = {
  mode: 'openai' as Mode,
  /** Conversation for the OpenAI/Anthropic modes (kept in this page, resent each time). */
  history: [] as Msg[],
  /** Messages of the selected claude.ai chat (bridge mode). */
  chatMessages: [] as Msg[],
  chats: [] as ConversationSummary[],
  chatId: null as string | null,
  chatUrl: null as string | null,
  busy: null as AbortController | null,
};

let afterSend: () => void = () => undefined;

// Saved preferences are best effort: storage can be unavailable.

function loadPrefs(): void {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (MODES.includes(p.mode)) state.mode = p.mode;
    if (typeof p.stream === 'boolean') els.stream.checked = p.stream;
    if (typeof p.system === 'string') els.system.value = p.system;
    if (typeof p.model === 'string') els.model.dataset.saved = p.model;
  } catch {
    // keep the defaults
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ mode: state.mode, stream: els.stream.checked, system: els.system.value, model: els.model.value })
    );
  } catch {
    // not saved
  }
}

export async function loadModels(): Promise<void> {
  // The model saved from last time wins until the list has loaded once.
  const wanted = els.model.dataset.saved || els.model.value || DEFAULT_MODEL;
  let ids = [DEFAULT_MODEL];
  try {
    ids = (await getJson<{ data: Array<{ id: string }> }>('/v1/models')).data.map((m) => m.id);
    delete els.model.dataset.saved;
  } catch {
    // keep the default
  }
  els.model.replaceChildren(...ids.map((id) => new Option(id === DEFAULT_MODEL ? `${id} (account default)` : id, id)));
  els.model.value = ids.includes(wanted) ? wanted : DEFAULT_MODEL;
}

function listNote(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'hint';
  li.textContent = text;
  return li;
}

async function loadChats(): Promise<void> {
  els.chatsRefresh.disabled = true;
  try {
    state.chats = (await getJson<{ data: ConversationSummary[] }>('/bridge/conversations?limit=30')).data;
    renderChats();
  } catch (e) {
    els.chats.replaceChildren(listNote(`Couldn't load chats: ${(e as Error).message}`));
  } finally {
    els.chatsRefresh.disabled = false;
  }
}

async function openChat(id: string): Promise<void> {
  if (state.busy) return;
  state.chatId = id;
  state.chatUrl = null;
  state.chatMessages = [{ role: 'assistant', text: 'Loading…', pending: true }];
  render();
  let messages: Msg[];
  let url: string | null = null;
  try {
    const c = await getJson<ConversationDetail>(`/bridge/conversations/${encodeURIComponent(id)}`);
    url = c.url;
    messages = c.messages.map((m) => ({ role: m.role, text: m.text }));
  } catch (e) {
    messages = [{ role: 'assistant', text: `Couldn't load this chat: ${(e as Error).message}`, error: true }];
  }
  // Another chat may have been picked while this one loaded.
  if (state.chatId !== id) return;
  state.chatUrl = url;
  state.chatMessages = messages;
  render();
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

async function send(text: string): Promise<void> {
  const mode = state.mode;
  const list = mode === 'bridge' ? state.chatMessages : state.history;
  const { path, body } = buildRequest({
    mode,
    text,
    history: state.history.filter((m) => !m.error && !m.pending).map((m) => ({ role: m.role, content: m.text })),
    model: els.model.value || DEFAULT_MODEL,
    system: els.system.value.trim(),
    stream: els.stream.checked,
    chatId: state.chatId,
  });
  const reply: Msg = { role: 'assistant', text: '', pending: true };
  list.push({ role: 'user', text }, reply);
  els.input.value = '';
  const ac = new AbortController();
  state.busy = ac;
  render();

  let raw = '';
  const addRaw = (t: string) => {
    if (raw.length < MAX_RAW) raw += t;
    els.rawRes.textContent = raw;
  };
  els.rawReq.textContent = `POST ${path}\n\n${JSON.stringify(body, null, 2)}`;
  els.rawRes.textContent = '';

  const started = performance.now();
  let firstText: number | undefined;
  let result: SendResult | undefined;

  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: apiHeaders(mode === 'anthropic' ? 'anthropic' : 'bearer'),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const requestId = res.headers.get('x-request-id');
    addRaw(`HTTP ${res.status}${requestId ? `  (request ${requestId})` : ''}\n\n`);
    if (!res.ok) {
      const t = await res.text();
      addRaw(t);
      throw errorFrom(res.status, t);
    }
    if (res.body && res.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const ev of readSseEvents(res.body, addRaw)) {
        const r = readEvent(mode, ev);
        if (r.error) throw new ApiError(r.error);
        if (r.result) result = r.result;
        if (r.text) {
          firstText ??= performance.now();
          reply.text += r.text;
          renderMessages();
        }
      }
    } else {
      const t = await res.text();
      addRaw(t);
      const j: unknown = JSON.parse(t);
      reply.text = fullText(mode, j);
      if (mode === 'bridge') result = j as SendResult;
    }
    reply.meta = [
      firstText !== undefined ? `first text after ${seconds(firstText - started)}` : null,
      `total ${seconds(performance.now() - started)}`,
      `${reply.text.length} chars`,
    ]
      .filter(Boolean)
      .join(' · ');
    if (result) {
      state.chatId = result.conversationId;
      state.chatUrl = result.url;
      void loadChats();
    }
  } catch (e) {
    if (ac.signal.aborted) {
      reply.meta = 'Stopped';
    } else {
      const err = e as ApiError;
      reply.error = true;
      reply.text += `${reply.text ? '\n\n' : ''}${err.status ? `HTTP ${err.status} · ` : ''}${err.code ? `${err.code}: ` : ''}${err.message}`;
    }
  } finally {
    reply.pending = false;
    state.busy = null;
    render();
    afterSend();
  }
}

function renderMessages(): void {
  const list = state.mode === 'bridge' ? state.chatMessages : state.history;
  els.empty.hidden = list.length > 0;
  const nodes = list.map((m) => {
    const div = document.createElement('div');
    div.className = `msg ${m.role}${m.error ? ' error' : ''}${m.pending ? ' pending' : ''}`;
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = m.text;
    div.append(body);
    if (m.meta) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = m.meta;
      div.append(meta);
    }
    return div;
  });
  els.messages.replaceChildren(els.empty, ...nodes);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderChats(): void {
  if (!state.chats.length) {
    els.chats.replaceChildren(listNote('No chats yet.'));
    return;
  }
  els.chats.replaceChildren(
    ...state.chats.map((c) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.name || 'Untitled chat';
      if (c.id === state.chatId) b.setAttribute('aria-current', 'true');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '';
      b.append(when);
      b.addEventListener('click', () => void openChat(c.id));
      li.append(b);
      return li;
    })
  );
}

function render(): void {
  const bridge = state.mode === 'bridge';
  for (const b of els.modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  els.modeHint.textContent = MODE_HINTS[state.mode];
  els.systemSection.hidden = bridge;
  els.chatsSection.hidden = !bridge;

  if (bridge) {
    const chat = state.chats.find((c) => c.id === state.chatId);
    els.chatTitle.textContent = state.chatId ? chat?.name || 'claude.ai chat' : 'New claude.ai chat';
    els.chatLink.hidden = !state.chatUrl || !state.chatId;
    if (state.chatUrl) els.chatLink.href = state.chatUrl;
    els.clear.textContent = 'New chat';
    renderChats();
  } else {
    els.chatTitle.textContent = state.history.length ? 'Conversation (kept in this page)' : 'New conversation';
    els.chatLink.hidden = true;
    els.clear.textContent = 'Clear';
  }

  const busy = !!state.busy;
  els.send.disabled = busy;
  els.stop.hidden = !busy;
  for (const b of els.modeButtons) b.disabled = busy;
  renderMessages();
}

function newConversation(): void {
  if (state.busy) return;
  if (state.mode === 'bridge') {
    state.chatId = null;
    state.chatUrl = null;
    state.chatMessages = [];
  } else {
    state.history = [];
  }
  render();
  els.input.focus();
}

/** Sets up the playground. `onSent` runs after every request (e.g. to refresh status). */
export function initPlayground(onSent: () => void): void {
  afterSend = onSent;

  for (const b of els.modeButtons) {
    b.addEventListener('click', () => {
      state.mode = b.dataset.mode as Mode;
      savePrefs();
      render();
      if (state.mode === 'bridge' && !state.chats.length) void loadChats();
    });
  }

  for (const el of [els.stream, els.model]) el.addEventListener('change', savePrefs);
  els.system.addEventListener('input', savePrefs);
  els.chatsRefresh.addEventListener('click', () => void loadChats());
  els.newChat.addEventListener('click', newConversation);
  els.clear.addEventListener('click', newConversation);
  els.stop.addEventListener('click', () => state.busy?.abort());

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.input.value.trim();
    if (text && !state.busy) void send(text);
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  loadPrefs();
  els.model.replaceChildren(new Option(`${DEFAULT_MODEL} (account default)`, DEFAULT_MODEL));
  render();
  void loadModels();
  if (state.mode === 'bridge') void loadChats();
}

/** Called when the Playground tab is shown. */
export function focusPlayground(): void {
  els.input.focus();
}

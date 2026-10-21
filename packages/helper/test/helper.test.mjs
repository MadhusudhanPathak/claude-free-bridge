// End-to-end tests for the helper: real HTTP server + WebSocket, with a fake browser extension
// standing in for the real one. Run with `npm test` (builds first).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { WebSocket } from 'ws';

process.env.CLAUDE_FB_QUIET = '1';
const require = createRequire(import.meta.url);
const { startHelper } = require('../dist/server.js');

const API_KEY = 'test-api-key';
const PAIRING = 'test-pairing-token';
const UI_TOKEN = 'test-ui-token';
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const baseStatus = (over = {}) => ({
  loggedIn: true,
  account: { email: 'me@example.com', name: 'Me', org: { id: 'org-1', name: 'Personal', plan: 'Pro' }, orgs: [] },
  settings: { apiChats: 'keep', models: ['claude-allowed-model'], orgId: '' },
  ...over,
});

class BridgeErr extends Error {
  constructor(code, message, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Speaks the extension side of the protocol; `handlers[op](params, { chunk, frame })` answer requests. */
class FakeExtension {
  constructor(helper, { token = PAIRING, origin = EXT_ORIGIN, instanceId = 'instance-1', status = baseStatus() } = {}) {
    Object.assign(this, { helper, token, origin, instanceId, status });
    this.handlers = {};
    this.requests = [];
    this.cancels = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.helper.url.replace('http', 'ws') + '/ext', { origin: this.origin });
      this.ws = ws;
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'hello', token: this.token, protocol: 1, instanceId: this.instanceId, version: '0.0.0', browser: 'FakeBrowser', status: this.status }))
      );
      ws.on('message', async (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') return resolve();
        if (msg.type === 'cancel') return this.cancels.push(msg.id);
        if (msg.type !== 'request') return;
        this.requests.push(msg);
        const handler = this.handlers[msg.op];
        try {
          if (!handler) throw new BridgeErr('UPSTREAM_ERROR', `no fake handler for ${msg.op}`);
          const data = await handler(msg.params, { chunk: (text) => ws.send(JSON.stringify({ type: 'chunk', id: msg.id, text })), frame: msg });
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: { code: e.code ?? 'UPSTREAM_ERROR', message: e.message, retryAfter: e.retryAfter } }));
        }
      });
      ws.on('close', (code, reason) => reject(Object.assign(new Error(`closed ${code} ${reason}`), { code })));
      ws.on('error', reject);
    });
  }

  setStatus(status) {
    this.status = status;
    this.ws.send(JSON.stringify({ type: 'status', status }));
  }

  close() {
    this.ws?.terminate();
  }
}

const sendReply = (text) => async (params, { chunk }) => {
  for (const piece of text.match(/.{1,5}/gs)) chunk(piece);
  return { conversationId: 'conv-1', url: 'https://claude.ai/chat/conv-1', messageId: 'm-1', text, stopReason: 'end_turn', deleted: false };
};

async function api(helper, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(helper.url + path, {
    method,
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
    });
}

function rawRequest(helper, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(helper.url + path, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

let helper;
let ext;
let cfg;

before(async () => {
  cfg = {
    apiKey: API_KEY,
    pairingToken: PAIRING,
    uiToken: UI_TOKEN,
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: ['http://allowed.local'],
    requestTimeoutMs: 5000,
    authWaitMs: 3000,
    connectWaitMs: 300,
  };
  helper = await startHelper(cfg, { extensionDir: null });
});

after(async () => {
  ext?.close();
  await helper.close();
});

beforeEach(async () => {
  ext?.close();
  await new Promise((r) => setTimeout(r, 30));
  ext = new FakeExtension(helper);
  await ext.connect();
});

describe('access control', () => {
  test('health needs no key, everything else does', async () => {
    const health = await fetch(helper.url + '/health');
    assert.equal(health.status, 200);
    assert.equal((await fetch(helper.url + '/v1/models')).status, 401);
    const wrong = await api(helper, '/v1/models', { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    const viaXKey = await fetch(helper.url + '/v1/models', { headers: { 'x-api-key': API_KEY } });
    assert.equal(viaXKey.status, 200);
  });

  test('requests from web pages are refused unless the origin is allowed', async () => {
    assert.equal((await api(helper, '/v1/models', { headers: { origin: 'https://evil.example' } })).status, 403);
    const allowed = await api(helper, '/v1/models', { headers: { origin: 'http://allowed.local' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://allowed.local');
  });

  test('the Control Center page is served without a key, and its own origin may call the API', async () => {
    const page = await fetch(helper.url + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /Set up in three steps/);
    assert.equal((await fetch(helper.url + '/ui.js')).status, 200);
    assert.equal((await fetch(helper.url + '/ui.css')).status, 200);
    const sameOrigin = await api(helper, '/v1/models', { headers: { origin: helper.url } });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null);
    const noKey = await fetch(helper.url + '/v1/models', { headers: { origin: helper.url } });
    assert.equal(noKey.status, 401, 'the page still needs the API key');
  });

  test('non-loopback Host headers are refused (DNS rebinding)', async () => {
    assert.equal(await rawRequest(helper, '/health', { host: 'evil.example' }), 403);
  });

  test('extension socket requires an extension origin and the pairing token', async () => {
    await assert.rejects(new FakeExtension(helper, { origin: 'https://evil.example', instanceId: 'x' }).connect(), /403/);
    await assert.rejects(new FakeExtension(helper, { token: 'wrong', instanceId: 'x' }).connect(), (e) => e.code === 4001);
    // The Control Center can tell the user the extension used a wrong code.
    ext.close();
    await new Promise((r) => setTimeout(r, 50));
    const status = await api(helper, '/bridge/status');
    assert.equal(status.json.extension.lastRejection.reason, 'wrong-pairing-code');
  });

  test('malformed frames from the extension are refused or ignored, never fatal', async () => {
    const code = await new Promise((resolve, reject) => {
      const ws = new WebSocket(helper.url.replace('http', 'ws') + '/ext', { origin: EXT_ORIGIN });
      ws.on('open', () => ws.send('null'));
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    assert.equal(code, 4003, 'a hello that is not an object is refused');

    for (const junk of ['null', '[]', '42', 'not json', '{"type":"status","status":null}']) ext.ws.send(junk);
    ext.handlers.send = sendReply('still fine');
    const r = await api(helper, '/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, 'still fine');
    assert.equal((await api(helper, '/bridge/status')).json.loggedIn, true, 'a malformed status is ignored');
  });

  test('a second browser is turned away while the first is connected', async () => {
    await assert.rejects(new FakeExtension(helper, { instanceId: 'other-browser' }).connect(), (e) => e.code === 4002);
    // The same browser reconnecting (e.g. service worker restart) replaces the old connection.
    const again = new FakeExtension(helper, { instanceId: 'instance-1' });
    await again.connect();
    again.close();
  });
});

describe('OpenAI-compatible API', () => {
  test('non-streaming completion flattens history into one prompt', async () => {
    ext.handlers.send = sendReply('Hello there!');
    const r = await api(helper, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hey' },
          { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
        ],
      },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, 'Hello there!');
    assert.equal(r.json.model, 'gpt-4o');
    const params = ext.requests.at(-1).params;
    assert.equal(params.source, 'api');
    assert.equal(params.model, undefined, 'unknown models are not passed to claude.ai');
    assert.match(params.text, /<system_instructions>\nBe brief\.\n<\/system_instructions>/);
    assert.match(params.text, /<message role="assistant">\nHey\n<\/message>/);
    assert.ok(params.text.endsWith('How are you?'));
    assert.match(params.newChatName, /^API · How are you\?/);
  });

  test('a lone user message is sent as-is, and allowed models pass through', async () => {
    ext.handlers.send = sendReply('ok');
    await api(helper, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'claude-allowed-model', messages: [{ role: 'user', content: 'Just this' }] },
    });
    const params = ext.requests.at(-1).params;
    assert.equal(params.text, 'Just this');
    assert.equal(params.model, 'claude-allowed-model');
  });

  test('streaming sends deltas and ends with [DONE]', async () => {
    ext.handlers.send = sendReply('Streaming works fine.');
    const r = await api(helper, '/v1/chat/completions', {
      method: 'POST',
      body: { stream: true, messages: [{ role: 'user', content: 'Stream please' }] },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const events = sseEvents(r.text);
    assert.equal(events.at(-1).data, '[DONE]');
    const text = events
      .slice(0, -1)
      .map((e) => e.data.choices[0].delta.content ?? '')
      .join('');
    assert.equal(text, 'Streaming works fine.');
    assert.equal(events.at(-2).data.choices[0].finish_reason, 'stop');
  });

  test('models list includes the default and the allowed models', async () => {
    const r = await api(helper, '/v1/models');
    assert.deepEqual(
      r.json.data.map((m) => m.id),
      ['claude-web', 'claude-allowed-model']
    );
  });

  test('bad requests get a 400 without reaching the extension', async () => {
    const before = ext.requests.length;
    const r = await api(helper, '/v1/chat/completions', { method: 'POST', body: { messages: [] } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.type, 'invalid_request_error');
    const img = await api(helper, '/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },
    });
    assert.equal(img.status, 400);
    assert.equal(ext.requests.length, before);
  });
});

describe('Anthropic-compatible API', () => {
  test('non-streaming message', async () => {
    ext.handlers.send = sendReply('Bonjour');
    const r = await api(helper, '/v1/messages', {
      method: 'POST',
      headers: { 'anthropic-version': '2023-06-01' },
      body: { model: 'claude-x', max_tokens: 100, system: [{ type: 'text', text: 'French only.' }], messages: [{ role: 'user', content: 'Hello' }] },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.type, 'message');
    assert.deepEqual(r.json.content, [{ type: 'text', text: 'Bonjour' }]);
    assert.equal(r.json.stop_reason, 'end_turn');
    assert.match(ext.requests.at(-1).params.text, /French only\./);
  });

  test('streaming emits Anthropic events in order', async () => {
    ext.handlers.send = sendReply('One two three');
    const r = await api(helper, '/v1/messages', {
      method: 'POST',
      body: { max_tokens: 100, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Count' }] }] },
    });
    const events = sseEvents(r.text);
    const names = [...new Set(events.map((e) => e.event))];
    assert.deepEqual(names, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const text = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('');
    assert.equal(text, 'One two three');
  });

  test('errors use Anthropic error shape; rate limits carry Retry-After', async () => {
    ext.handlers.send = async () => {
      throw new BridgeErr('RATE_LIMITED', 'usage limit reached', 120);
    };
    const r = await api(helper, '/v1/messages', { method: 'POST', body: { max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '120');
    assert.equal(r.json.type, 'error');
    assert.equal(r.json.error.type, 'rate_limit_error');
  });
});

describe('queue behaviour', () => {
  test('requests run one at a time', async () => {
    let running = 0;
    let maxRunning = 0;
    ext.handlers.send = async (params) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return { conversationId: 'c', url: '', messageId: null, text: params.text, stopReason: 'end_turn', deleted: false };
    };
    const results = await Promise.all(
      ['a', 'b', 'c'].map((t) => api(helper, '/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: t }] } }))
    );
    assert.deepEqual(results.map((r) => r.json.choices[0].message.content), ['a', 'b', 'c']);
    assert.equal(maxRunning, 1);
  });

  test('an expired login holds the request until the extension reports logged in, then retries', async () => {
    let calls = 0;
    ext.handlers.send = async (params, ctx) => {
      calls++;
      if (calls === 1) {
        ext.setStatus(baseStatus({ loggedIn: false, account: null }));
        setTimeout(() => ext.setStatus(baseStatus()), 200);
        throw new BridgeErr('AUTH_INVALID', 'session expired');
      }
      return sendReply('after login')(params, ctx);
    };
    const r = await api(helper, '/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, 'after login');
    assert.equal(calls, 2);
  });

  test('without an extension, requests fail with 503 after a short wait', async () => {
    ext.close();
    await new Promise((r) => setTimeout(r, 50));
    const r = await api(helper, '/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'EXTENSION_DISCONNECTED');
  });

  test('a client that disconnects mid-stream cancels the job in the extension', async () => {
    let started;
    const startedP = new Promise((r) => (started = r));
    ext.handlers.send = async (params, { chunk }) => {
      chunk('partial');
      started();
      await new Promise((r) => setTimeout(r, 2000));
      return { conversationId: 'c', url: '', messageId: null, text: 'late', stopReason: 'end_turn', deleted: false };
    };
    const ac = new AbortController();
    const res = await fetch(helper.url + '/v1/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'long' }] }),
    });
    await startedP;
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ext.cancels.length, 1);
    assert.equal(ext.cancels[0], ext.requests.at(-1).id);
  });
});

describe('native bridge API', () => {
  test('status reports the extension and account', async () => {
    const r = await api(helper, '/bridge/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.extension.connected, true);
    assert.equal(r.json.extension.browser, 'FakeBrowser');
    assert.equal(r.json.loggedIn, true);
    assert.equal(r.json.account.email, 'me@example.com');
  });

  test('list, read, create and delete conversations', async () => {
    ext.handlers.listConversations = async (p) => [{ id: 'c1', name: `limit ${p.limit}`, createdAt: '', updatedAt: '', model: null, url: '' }];
    ext.handlers.getConversation = async (p) => ({ id: p.id, name: 'n', createdAt: '', updatedAt: '', model: null, url: '', messages: [] });
    ext.handlers.createConversation = async (p) => ({ id: 'new', name: p.name, createdAt: '', updatedAt: '', model: null, url: '' });
    ext.handlers.deleteConversation = async () => ({ deleted: true });

    assert.equal((await api(helper, '/bridge/conversations?limit=5')).json.data[0].name, 'limit 5');
    assert.equal((await api(helper, '/bridge/conversations/abc-123')).json.id, 'abc-123');
    const created = await api(helper, '/bridge/conversations', { method: 'POST', body: { name: 'My chat' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.name, 'My chat');
    assert.equal((await api(helper, '/bridge/conversations/abc-123', { method: 'DELETE' })).json.deleted, true);
    assert.equal((await api(helper, '/bridge/conversations/bad%20id')).status, 400);
  });

  test('send into an existing chat, streaming', async () => {
    ext.handlers.send = sendReply('Continuing the chat');
    const r = await api(helper, '/bridge/conversations/conv-1/messages', { method: 'POST', body: { text: 'next', stream: true } });
    const events = sseEvents(r.text);
    assert.equal(events[0].event, 'start');
    assert.equal(events.filter((e) => e.event === 'chunk').map((e) => e.data.text).join(''), 'Continuing the chat');
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.conversationId, 'conv-1');
    const params = ext.requests.at(-1).params;
    assert.equal(params.conversationId, 'conv-1');
    assert.equal(params.source, 'bridge');
  });

  test('send to a new chat, non-streaming', async () => {
    ext.handlers.send = sendReply('Fresh');
    const r = await api(helper, '/bridge/messages', { method: 'POST', body: { text: 'hello', name: 'Named' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.text, 'Fresh');
    assert.ok(r.json.requestId);
    assert.equal(ext.requests.at(-1).params.newChatName, 'Named');
    assert.equal(ext.requests.at(-1).params.conversationId, undefined);
  });

  test('not found maps to 404', async () => {
    ext.handlers.getConversation = async () => {
      throw new BridgeErr('NOT_FOUND', 'no such chat');
    };
    const r = await api(helper, '/bridge/conversations/missing');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'NOT_FOUND');
  });
});

describe('Control Center API', () => {
  const ui = (path, { method = 'GET', token = UI_TOKEN } = {}) =>
    fetch(helper.url + path, { method, headers: token ? { 'x-cfb-ui': token } : {} });

  test('keys are only shown to the window the app opened (with its token)', async () => {
    assert.equal((await ui('/ui/session', { token: null })).status, 403);
    assert.equal((await ui('/ui/session', { token: 'wrong' })).status, 403);
    // A web page can't simply send the header: cross-origin requests are refused outright.
    const fromSite = await fetch(helper.url + '/ui/session', { headers: { 'x-cfb-ui': UI_TOKEN, origin: 'https://evil.example' } });
    assert.equal(fromSite.status, 403);
    const s = await (await ui('/ui/session')).json();
    assert.equal(s.apiKey, API_KEY);
    assert.equal(s.pairingToken, PAIRING);
    assert.equal(s.apiUrl, helper.url);
    assert.equal(s.canQuit, false);
  });

  test('quit is unavailable unless the app provides it', async () => {
    assert.equal((await ui('/ui/quit', { method: 'POST' })).status, 404);
  });

  test('resetting keys invalidates the old API key and makes the extension pair again', async () => {
    const closed = new Promise((resolve) => ext.ws.once('close', (code) => resolve(code)));
    const s = await (await ui('/ui/reset-keys', { method: 'POST' })).json();
    assert.notEqual(s.apiKey, API_KEY);
    assert.notEqual(s.pairingToken, PAIRING);
    assert.equal(await closed, 4001);
    assert.equal((await api(helper, '/v1/models')).status, 401, 'old key no longer works');
    const fresh = await fetch(helper.url + '/v1/models', { headers: { authorization: `Bearer ${s.apiKey}` } });
    assert.equal(fresh.status, 200);
    await new FakeExtension(helper, { token: s.pairingToken, instanceId: 'after-reset' }).connect().then(() => undefined);

    // Restore the original secrets for any later tests.
    cfg.apiKey = API_KEY;
    cfg.pairingToken = PAIRING;
    helper.link.setPairingToken(PAIRING);
  });
});

describe('settings file', () => {
  const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const runCli = (home, args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env: { ...process.env, CLAUDE_FB_HOME: home } }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr })
      );
    });
  const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-test-'));

  test('the first run creates config.json with defaults and fresh secrets', async () => {
    const home = tempHome();
    const r = await runCli(home, ['token']);
    assert.equal(r.code, 0, r.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.match(saved.apiKey, /^cfb-/);
    assert.match(saved.pairingToken, /^cfbpair-/);
    assert.equal(saved.port, 8080);
    assert.ok(r.stdout.includes(saved.apiKey));
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('a broken or invalid config.json is reported and left untouched', async () => {
    for (const content of ['{ "apiKey": "cfb-keep-me", ', '{ "port": "eighty" }', '[1, 2]']) {
      const home = tempHome();
      const file = path.join(home, 'config.json');
      fs.writeFileSync(file, content);
      const r = await runCli(home, ['token']);
      assert.equal(r.code, 1, `exit code for ${content}`);
      assert.match(r.stderr, /config\.json/);
      assert.equal(fs.readFileSync(file, 'utf8'), content, 'the file is not overwritten');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

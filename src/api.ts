import http from 'http';
import { URL } from 'url';
import { sendPromptViaPlaywright } from './transport/playwright';
import { AuthInvalidError, getLastActiveOrg, hasStoredAuth } from './session/auth';
import { debug, error, info, warn } from './logger';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionRequestBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  id: string;
  model: string;
  object: 'chat.completion';
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }>;
  usage: { prompt_tokens: null; completion_tokens: null; total_tokens: null };
}

interface QueueItem {
  id: string;
  payload: ChatCompletionRequestBody;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  stream: boolean;
  res?: http.ServerResponse;
}

function isAuthInvalid(e: unknown): boolean {
  return e instanceof AuthInvalidError || (typeof e === 'string' && e.includes('Authentication failed'));
}

function validateRequestBody(body: unknown): { ok: true; value: ChatCompletionRequestBody } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.messages !== undefined) {
    if (!Array.isArray(candidate.messages)) {
      return { ok: false, error: '"messages" must be an array' };
    }
    for (const m of candidate.messages) {
      if (typeof m !== 'object' || m === null || typeof (m as ChatMessage).role !== 'string' || typeof (m as ChatMessage).content !== 'string') {
        return { ok: false, error: 'Each message must have string "role" and "content" fields' };
      }
    }
  }
  return { ok: true, value: candidate as ChatCompletionRequestBody };
}

// Single-worker FIFO queue: claude.ai's web UI supports one active conversation per browser
// context, so requests are processed strictly one at a time to avoid input races.
class RequestQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private paused = false;
  private pauseResolve?: () => void;

  enqueue(id: string, payload: ChatCompletionRequestBody, stream = false, res?: http.ServerResponse): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id, payload, resolve, reject, stream, res });
      if (!this.isProcessing) this.worker();
    });
  }

  private async worker(): Promise<void> {
    this.isProcessing = true;
    while (this.queue.length > 0) {
      if (this.paused) {
        debug('Queue paused; waiting for re-auth');
        await new Promise<void>((r) => { this.pauseResolve = r; });
      }

      const item = this.queue.shift()!;
      try {
        debug('Processing queued request', item.id);
        if (item.stream && item.res) {
          await this.processStream(item.payload, item.res, item.resolve, item.reject);
        } else {
          item.resolve(await this.process(item.payload));
        }
      } catch (e) {
        if (isAuthInvalid(e)) {
          await this.pauseForReauth(item);
          continue;
        }
        item.reject(e);
      }
    }
    this.isProcessing = false;
  }

  // There is no automatic re-login (the ported session model never drives a browser through a
  // login flow — see session/auth.ts). Instead the queue just pauses and polls for the operator
  // to fix the session out of band (auth-set-session, auth-import-browser, or auth-use via the
  // CLI or GUI), then resumes automatically once a valid session reappears.
  private async pauseForReauth(item: QueueItem): Promise<void> {
    warn(
      'Auth invalid detected during request processing — pausing queue. Re-authenticate with ' +
      'auth-set-session, auth-import-browser, or auth-use (CLI or GUI) to resume.'
    );
    this.queue.unshift(item);
    this.paused = true;

    const pollIntervalMs = 3000;
    while (!hasStoredAuth()) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    info('Valid session detected — resuming queue');

    this.paused = false;
    this.pauseResolve?.();
    this.pauseResolve = undefined;
  }

  private async process(payload: ChatCompletionRequestBody): Promise<ChatCompletionResponse> {
    const prompt = buildPromptFromMessages(payload.messages ?? []);
    const timeoutMs = payload.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    const text = await sendPromptViaPlaywright(prompt, { headed: false, timeoutMs });

    return {
      id: `msg_web_${Date.now()}`,
      model: 'claude-3.5-web',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
    };
  }

  private async processStream(
    payload: ChatCompletionRequestBody,
    res: http.ServerResponse,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void
  ): Promise<void> {
    try {
      const prompt = buildPromptFromMessages(payload.messages ?? []);
      const timeoutMs = payload.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const onChunk = (chunk: string) => {
        const event = JSON.stringify({
          id: 'chatcmpl-web',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
        try {
          res.write(`data: ${event}\n\n`);
        } catch (e) {
          debug('Failed to write SSE chunk', e);
        }
      };

      try {
        await sendPromptViaPlaywright(prompt, { headed: false, timeoutMs, onChunk, stream: true });
        const done = JSON.stringify({ choices: [{ finish_reason: 'stop' }] });
        try { res.write(`data: ${done}\n\n`); } catch (e) { debug('Failed to write final SSE', e); }
      } catch (e) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`); } catch { /* client likely disconnected */ }
        throw e;
      } finally {
        res.end();
      }

      resolve({ streamed: true });
    } catch (e) {
      try { res.writeHead(500); res.end(); } catch { /* headers already sent */ }
      reject(e);
    }
  }
}

function buildPromptFromMessages(messages: ChatMessage[]): string {
  if (!messages.length) return '';
  return messages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}\n`).join('\n');
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const requestQueue = new RequestQueue();

async function handleHealth(res: http.ServerResponse): Promise<void> {
  try {
    const org = await getLastActiveOrg();
    sendJson(res, org ? 200 : 503, { status: org ? 'ok' : 'degraded', session_valid: !!org });
  } catch {
    sendJson(res, 503, { status: 'degraded', session_valid: false });
  }
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!hasStoredAuth()) {
    sendJson(res, 503, { error: 'No stored auth available. Use the CLI to authenticate (auth-set-session or auth-import-browser).' });
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const validated = validateRequestBody(rawBody);
  if (!validated.ok) {
    sendJson(res, 400, { error: validated.error });
    return;
  }

  const body = validated.value;
  const stream = !!body.stream;
  const id = `req_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  if (stream) {
    try {
      await requestQueue.enqueue(id, body, true, res);
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  try {
    const result = await requestQueue.enqueue(id, body, false);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

export function startServer(opts: { host?: string; port?: number } = {}): http.Server {
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port || DEFAULT_PORT;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || host}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        await handleHealth(res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, { data: [{ id: 'claude-3.5-web' }], object: 'list' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleChatCompletions(req, res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
  });

  server.listen(port, host, () => {
    info(`API server listening http://${host}:${port}`);
  });

  server.on('error', (e) => {
    error('API server error', e);
  });

  return server;
}

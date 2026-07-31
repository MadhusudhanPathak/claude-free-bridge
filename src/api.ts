import http from 'http';
import { URL } from 'url';
import { sendPromptViaPlaywright } from './transport/playwright';
import { getLastActiveOrg, hasStoredAuth, ensureAuth } from './session/auth';
import { info, debug, error, warn } from './logger';

type Message = { role: string; content: string };

// Simple FIFO request queue with single worker
class RequestQueue {
  private queue: Array<{
    id: string;
    payload: any;
    resolve: (v: any) => void;
    reject: (e: any) => void;
    stream: boolean;
    res?: http.ServerResponse;
  }> = [];
  private isProcessing = false;

  private paused = false;
  private pauseResolve?: () => void;

  enqueue(id: string, payload: any, stream = false, res?: http.ServerResponse) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id, payload, resolve, reject, stream, res });
      if (!this.isProcessing) this.worker();
    });
  }

  private async worker() {
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
          const out = await this.process(item.payload);
          item.resolve(out);
        }
      } catch (e: any) {
        // If auth invalid, pause the queue, trigger interactive re-auth, then re-enqueue the failed item and resume
        if (e && (e.code === 'E_AUTH_INVALID' || (typeof e === 'string' && e.includes('Authentication failed')))) {
          warn('Auth invalid detected during request processing — pausing queue and triggering re-auth');
          // re-enqueue the current item to the front
          this.queue.unshift(item);
          this.paused = true;
          try {
            await ensureAuth(true, 0);
          } catch (reauthErr) {
            error('Re-auth failed or was cancelled', reauthErr);
          }
          this.paused = false;
          if (this.pauseResolve) { this.pauseResolve(); this.pauseResolve = undefined; }
          // continue loop — the re-enqueued item will be processed after resume
          continue;
        }
        item.reject(e);
      }
    }
    this.isProcessing = false;
  }

  private async process(payload: any) {
    // Build a plain prompt string from messages
    const messages: Message[] = Array.isArray(payload.messages) ? payload.messages : [];
    const prompt = buildPromptFromMessages(messages);
    const headed = false;
    const timeoutMs = payload.timeoutMs || 120000;
    const text = await sendPromptViaPlaywright(prompt, { headed, timeoutMs });

    // Map to Anthropic-like response
    const resp = {
      id: `msg_web_${Date.now()}`,
      model: 'claude-3.5-web',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
    };
    return resp;
  }

  private async processStream(payload: any, res: http.ServerResponse, resolve: (v:any)=>void, reject: (e:any)=>void) {
    try {
      const messages: Message[] = Array.isArray(payload.messages) ? payload.messages : [];
      const prompt = buildPromptFromMessages(messages);
      const headed = false;
      const timeoutMs = payload.timeoutMs || 120000;

      // Setup SSE response immediately so client sees headers while we poll
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Provide an onChunk handler that writes SSE events as Anthropic-like chunks
      let seq = 0;
      const onChunk = (chunk: string) => {
        const event = JSON.stringify({ id: `chatcmpl-web`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
        try {
          res.write(`data: ${event}\n\n`);
        } catch (e) {
          debug('Failed to write SSE chunk', e);
        }
        seq++;
      };

      // Call transport in streaming mode; it will invoke onChunk as it observes deltas
      try {
        const final = await sendPromptViaPlaywright(prompt, { headed, timeoutMs, onChunk, stream: true });
        // send final stop event
        const done = JSON.stringify({ choices: [{ finish_reason: 'stop' }] });
        try { res.write(`data: ${done}\n\n`); } catch (e) { debug('Failed to write final SSE', e); }
      } catch (e) {
        // If transport threw, signal error to client
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`); } catch (er) {}
        throw e;
      } finally {
        try { res.end(); } catch {}
      }

      resolve({ streamed: true });
    } catch (e) {
      try { res.writeHead(500); res.end(); } catch (er) {}
      reject(e);
    }
  }
}

function buildPromptFromMessages(messages: Message[]) {
  if (!messages || messages.length === 0) return '';
  // If conversation_uuid is supplied externally, treat messages as canonical history
  // Map messages -> a single prompt that preserves roles
  return messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}\n`).join('\n');
}

// Tiny JSON body parser
async function readJson(req: http.IncomingMessage) {
  return new Promise<any>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const q = new RequestQueue();

export function startServer(opts: { host?: string; port?: number } = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 8080;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || host}`);
      // Health
      if (req.method === 'GET' && url.pathname === '/health') {
        try {
          const org = await getLastActiveOrg();
          if (org) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', session_valid: true }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'degraded', session_valid: false }));
          }
        } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'degraded', session_valid: false }));
        }
        return;
      }

      // Models
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'claude-3.5-web' }], object: 'list' }));
        return;
      }

      // Chat completions
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        // Ensure auth exists before proceeding
        if (!hasStoredAuth()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No stored auth available. Use the CLI to authenticate (auth-info --login).' }));
          return;
        }

        let body: any;
        try {
          body = await readJson(req);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        const stream = !!body.stream;
        const id = `req_${Date.now()}_${Math.floor(Math.random()*1000)}`;

        if (stream) {
          // Enqueue and provide res for streaming
          try {
            await q.enqueue(id, body, true, res);
            // q.worker will end the response; nothing else to do here
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        try {
          const result = await q.enqueue(id, body, false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? String(e) }));
        }

        return;
      }

      // Unknown
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
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

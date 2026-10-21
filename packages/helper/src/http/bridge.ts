// Native bridge API: work with real claude.ai chats (they show up in claude.ai's sidebar).
import * as crypto from 'crypto';
import type * as http from 'http';
import { BridgeFailure, toBridgeError } from '../../../shared/src/errors';
import { BRIDGE_VERSION, type SendParams } from '../../../shared/src/protocol';
import type { Ctx } from './context';
import { abortOnClientGone, badRequest, LazySse, sendError, sendJson } from './io';
import { pickModel } from './models';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DIRECT_TIMEOUT_MS = 60_000;

export function bridgeError(res: http.ServerResponse, e: unknown): void {
  sendError(res, e, (error) => ({ error }));
}

/** Non-send operations skip the queue (they're quick) but still wait briefly for the extension. */
async function direct<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await ctx.link.waitUntil(
    () => ctx.link.connected,
    ctx.cfg.connectWaitMs,
    new BridgeFailure('EXTENSION_DISCONNECTED', 'The browser extension is not connected to the helper')
  );
  return fn();
}

function statusBody(ctx: Ctx) {
  const { link, queue } = ctx;
  const s = link.status;
  return {
    helper: { version: BRIDGE_VERSION },
    extension: {
      connected: link.connected,
      browser: link.connected ? link.browser : null,
      version: link.connected ? link.extensionVersion : null,
      lastRejection: link.lastRejection,
    },
    loggedIn: link.connected ? (s?.loggedIn ?? false) : null,
    account: link.connected ? (s?.account ?? null) : null,
    settings: s?.settings ?? null,
    queue: { length: queue.length, waitingForLogin: queue.waitingForLogin },
  };
}

function requireText(body: Record<string, unknown>): string {
  if (typeof body.text !== 'string' || !body.text.trim()) throw badRequest('"text" must be a non-empty string');
  return body.text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function queryInt(query: URLSearchParams, name: string, fallback: number, min: number, max: number, rule: string): number {
  const n = Number(query.get(name) ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`"${name}" must be ${rule}`);
  return n;
}

async function sendMessage(ctx: Ctx, res: http.ServerResponse, body: Record<string, unknown>, conversationId?: string): Promise<void> {
  const params: SendParams = {
    text: requireText(body),
    conversationId,
    model: pickModel(ctx, body.model),
    newChatName: optionalString(body.name),
    source: 'bridge',
  };
  const requestId = crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  const ac = abortOnClientGone(res);
  ctx.inflight.set(requestId, ac);

  try {
    if (!body.stream) {
      const r = await ctx.queue.enqueue(params, { signal: ac.signal });
      sendJson(res, 200, { requestId, ...r });
      return;
    }

    const stream = new LazySse(res, () => stream.send({ requestId }, 'start'));
    try {
      const r = await ctx.queue.enqueue(params, { signal: ac.signal, onChunk: (text) => stream.send({ text }, 'chunk') });
      stream.send({ requestId, ...r }, 'done');
    } catch (e) {
      if (!stream.started) throw e;
      stream.send({ error: toBridgeError(e) }, 'error');
    }
    stream.end();
  } finally {
    ctx.inflight.delete(requestId);
  }
}

/** Handles a /bridge/* request (`path` without a trailing slash). Returns false if no route matched. */
export async function handleBridge(
  ctx: Ctx,
  method: string,
  path: string,
  query: URLSearchParams,
  res: http.ServerResponse,
  readBody: () => Promise<Record<string, unknown>>
): Promise<boolean> {
  const parts = path.split('/').slice(2); // after "/bridge"
  const takesId = parts[0] === 'conversations' || parts[0] === 'cancel';
  const route = `${method} /${parts.map((p, i) => (i === 1 && takesId ? ':id' : p)).join('/')}`;
  const id = parts[1];

  try {
    if (id !== undefined && !ID.test(id)) throw badRequest('Invalid id');
    switch (route) {
      case 'GET /status':
        if (query.get('refresh') === '1' && ctx.link.connected) {
          await ctx.link.call('status', {}, { timeoutMs: DIRECT_TIMEOUT_MS }).catch(() => undefined);
        }
        sendJson(res, 200, statusBody(ctx));
        return true;

      case 'GET /conversations': {
        const limit = queryInt(query, 'limit', 30, 1, 200, '1–200');
        const offset = queryInt(query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER, '0 or more');
        const data = await direct(ctx, () => ctx.link.call('listConversations', { limit, offset }, { timeoutMs: DIRECT_TIMEOUT_MS }));
        sendJson(res, 200, { data });
        return true;
      }

      case 'POST /conversations': {
        const body = await readBody();
        const params = { name: optionalString(body.name), model: pickModel(ctx, body.model) };
        const data = await direct(ctx, () => ctx.link.call('createConversation', params, { timeoutMs: DIRECT_TIMEOUT_MS }));
        sendJson(res, 201, data);
        return true;
      }

      case 'GET /conversations/:id': {
        const data = await direct(ctx, () => ctx.link.call('getConversation', { id }, { timeoutMs: DIRECT_TIMEOUT_MS }));
        sendJson(res, 200, data);
        return true;
      }

      case 'DELETE /conversations/:id': {
        const data = await direct(ctx, () => ctx.link.call('deleteConversation', { id }, { timeoutMs: DIRECT_TIMEOUT_MS }));
        sendJson(res, 200, data);
        return true;
      }

      case 'POST /conversations/:id/messages':
        await sendMessage(ctx, res, await readBody(), id);
        return true;

      case 'POST /messages':
        await sendMessage(ctx, res, await readBody());
        return true;

      case 'POST /cancel/:id': {
        const ac = ctx.inflight.get(id);
        if (!ac) throw new BridgeFailure('NOT_FOUND', 'No such in-flight request');
        ac.abort();
        sendJson(res, 200, { cancelled: true });
        return true;
      }

      default:
        return false;
    }
  } catch (e) {
    bridgeError(res, e);
    return true;
  }
}

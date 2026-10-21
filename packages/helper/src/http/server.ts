import * as http from 'http';
import type { AddressInfo } from 'net';
import { log } from '../logger';
import { isLoopbackHost, safeEqual } from '../security';
import { anthropicError, anthropicMessages, anthropicModels } from './anthropic';
import { bridgeError, handleBridge } from './bridge';
import type { Ctx } from './context';
import { readJson, sendJson } from './io';
import { openAiChatCompletions, openAiError, openAiModels } from './openai';
import { handleUiApi, serveUiAsset } from './ui';

const UNAUTHORIZED_MESSAGE = 'Missing or wrong API key. Copy it from the Claude Free Bridge app ("Use with your apps").';

function presentedKey(req: http.IncomingMessage): string {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xKey = req.headers['x-api-key'];
  return typeof xKey === 'string' ? xKey.trim() : '';
}

function listeningPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

/**
 * Any web page can send requests to localhost, so the Host header must be a loopback name
 * (this blocks DNS rebinding). A deliberately exposed server skips this; the API key still applies.
 */
function hostAllowed(ctx: Ctx, server: http.Server, req: http.IncomingMessage): boolean {
  if (!isLoopbackHost(ctx.cfg.host)) return true;
  const port = listeningPort(server);
  const host = (req.headers.host || '').toLowerCase();
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}

/** The Control Center is served from this server, so its own origin needs no allow-listing. */
function isOwnOrigin(ctx: Ctx, server: http.Server, origin: string): boolean {
  const port = listeningPort(server);
  const hosts = ['127.0.0.1', 'localhost', '[::1]', ctx.cfg.host.includes(':') ? `[${ctx.cfg.host}]` : ctx.cfg.host];
  return hosts.some((h) => origin === `http://${h}:${port}`);
}

function isAnthropicStyle(path: string, req: http.IncomingMessage): boolean {
  return path.startsWith('/v1/messages') || (path === '/v1/models' && !!req.headers['anthropic-version']);
}

function sendRouteError(path: string, req: http.IncomingMessage, res: http.ServerResponse, e: unknown): void {
  if (isAnthropicStyle(path, req)) anthropicError(res, e);
  else if (path.startsWith('/bridge')) bridgeError(res, e);
  else openAiError(res, e);
}

/** Applies CORS for allow-listed origins. Returns false if the request was answered already. */
function handleOrigin(ctx: Ctx, server: http.Server, method: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin || isOwnOrigin(ctx, server, origin)) return true;
  if (!ctx.cfg.allowedOrigins.includes(origin)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: `Origin ${origin} is not in allowedOrigins` } });
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Expose-Headers', 'x-request-id, retry-after');
  if (method !== 'OPTIONS') return true;
  res.writeHead(204, {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '600',
  });
  res.end();
  return false;
}

async function handle(ctx: Ctx, server: http.Server, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  if (!hostAllowed(ctx, server, req)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Host not allowed' } });
    return;
  }
  if (!handleOrigin(ctx, server, method, req, res)) return;

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, extensionConnected: ctx.link.connected });
    return;
  }

  // The Control Center's files hold no secrets; /ui/* checks its own token.
  if (method === 'GET' && serveUiAsset(path, res)) return;
  if (handleUiApi(ctx, method, path, req, res)) return;

  if (!safeEqual(presentedKey(req), ctx.cfg.apiKey)) {
    // An API-key problem, not a claude.ai login one, hence its own code.
    if (isAnthropicStyle(path, req)) {
      sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: UNAUTHORIZED_MESSAGE } });
    } else {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: UNAUTHORIZED_MESSAGE, type: 'authentication_error' } });
    }
    return;
  }

  try {
    if (method === 'GET' && path === '/v1/models') {
      return isAnthropicStyle(path, req) ? anthropicModels(ctx, res) : openAiModels(ctx, res);
    }
    if (method === 'POST' && path === '/v1/chat/completions') {
      return await openAiChatCompletions(ctx, res, await readJson(req));
    }
    if (method === 'POST' && path === '/v1/messages') {
      return await anthropicMessages(ctx, res, await readJson(req));
    }
    if (path === '/bridge' || path.startsWith('/bridge/')) {
      if (await handleBridge(ctx, method, path, url.searchParams, res, () => readJson(req))) return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${method} ${path}` } });
  } catch (e) {
    sendRouteError(path, req, res, e);
  }
}

/** The HTTP server: public API, Control Center, and the extension's WebSocket upgrade. */
export function createHttpServer(ctx: Ctx): http.Server {
  const server = http.createServer((req, res) => {
    handle(ctx, server, req, res).catch((e) => {
      log.error('Unhandled error in request handler', e);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
      else res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (!hostAllowed(ctx, server, req) || !ctx.link.handleUpgrade(req, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  // Replies can take minutes; don't let Node cut long requests off.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

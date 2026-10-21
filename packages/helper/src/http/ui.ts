// The Control Center page (embedded at build time) and its private API under /ui/*.
// The page itself holds no secrets. /ui/* only answers requests that carry the uiToken, which
// the app puts in the URL it opens, so only that window can see the API key and pairing code.
import type * as http from 'http';
import { css, html, js } from 'virtual:ui-assets';
import { BRIDGE_VERSION } from '../../../shared/src/protocol';
import { newSecrets } from '../config';
import { log } from '../logger';
import { safeEqual } from '../security';
import type { Ctx } from './context';
import { sendJson } from './io';

const ASSETS: Record<string, { body: string; type: string }> = {
  '/': { body: html, type: 'text/html; charset=utf-8' },
  '/ui.js': { body: js, type: 'text/javascript; charset=utf-8' },
  '/ui.css': { body: css, type: 'text/css; charset=utf-8' },
};

const ASSET_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

/** Serves a Control Center file. Returns false if `urlPath` isn't one. */
export function serveUiAsset(urlPath: string, res: http.ServerResponse): boolean {
  const asset = ASSETS[urlPath];
  if (!asset) return false;
  res.writeHead(200, { 'Content-Type': asset.type, ...ASSET_HEADERS });
  res.end(asset.body);
  return true;
}

function notFound(res: http.ServerResponse, message: string): void {
  sendJson(res, 404, { error: { code: 'NOT_FOUND', message } });
}

function session(ctx: Ctx, req: http.IncomingMessage) {
  return {
    version: BRIDGE_VERSION,
    apiKey: ctx.cfg.apiKey,
    pairingToken: ctx.cfg.pairingToken,
    apiUrl: `http://${req.headers.host}`,
    extensionDir: ctx.app.extensionDir,
    canQuit: !!ctx.app.onQuit,
  };
}

/** Handles /ui/* requests. Returns false if the path isn't one. */
export function handleUiApi(ctx: Ctx, method: string, urlPath: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!urlPath.startsWith('/ui/')) return false;
  if (!safeEqual(String(req.headers['x-cfb-ui'] ?? ''), ctx.cfg.uiToken)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Open this page from the Claude Free Bridge app.' } });
    return true;
  }

  switch (`${method} ${urlPath}`) {
    case 'GET /ui/session':
      sendJson(res, 200, session(ctx, req));
      break;

    case 'POST /ui/open-extension-folder': {
      const { extensionDir, openFolder } = ctx.app;
      if (!extensionDir) {
        notFound(res, 'The extension folder was not found next to the app.');
      } else if (!openFolder) {
        notFound(res, 'Opening folders is not available here.');
      } else {
        openFolder(extensionDir);
        sendJson(res, 200, { ok: true });
      }
      break;
    }

    case 'POST /ui/reset-keys':
      Object.assign(ctx.cfg, newSecrets());
      ctx.app.saveConfig?.(ctx.cfg);
      ctx.link.setPairingToken(ctx.cfg.pairingToken);
      log.info('API key and pairing code were reset from the Control Center');
      sendJson(res, 200, session(ctx, req));
      break;

    case 'POST /ui/quit': {
      const { onQuit } = ctx.app;
      if (!onQuit) {
        notFound(res, 'Quitting is not available here.');
      } else {
        sendJson(res, 200, { ok: true });
        setTimeout(onQuit, 200);
      }
      break;
    }

    default:
      notFound(res, `No route for ${method} ${urlPath}`);
  }
  return true;
}

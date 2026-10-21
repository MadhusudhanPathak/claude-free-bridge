import type * as http from 'http';
import type { AddressInfo } from 'net';
import { BRIDGE_VERSION } from '../../shared/src/protocol';
import type { HelperConfig } from './config';
import { ExtensionLink } from './extensionLink';
import type { AppHooks } from './http/context';
import { createHttpServer } from './http/server';
import { SendQueue } from './queue';

const EXTENSION_WS_PATH = '/ext';

export interface RunningHelper {
  server: http.Server;
  link: ExtensionLink;
  queue: SendQueue;
  port: number;
  /** e.g. http://127.0.0.1:8080 */
  url: string;
  close(): Promise<void>;
}

/**
 * Starts the HTTP API, the Control Center and the extension WebSocket on one port.
 * Port 0 picks a free one. `cfg` may be changed in place later (e.g. reset keys).
 */
export function startHelper(cfg: HelperConfig, app: AppHooks = { extensionDir: null }): Promise<RunningHelper> {
  const link = new ExtensionLink({ pairingToken: cfg.pairingToken, helperVersion: BRIDGE_VERSION, path: EXTENSION_WS_PATH });
  const queue = new SendQueue(link, cfg);
  const server = createHttpServer({ cfg, app, link, queue, inflight: new Map() });

  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      link.close();
      reject(e);
    });
    server.listen(cfg.port, cfg.host, () => {
      const port = (server.address() as AddressInfo).port;
      const host = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
      resolve({
        server,
        link,
        queue,
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            link.close();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

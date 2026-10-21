import type { HelperConfig } from '../config';
import type { ExtensionLink } from '../extensionLink';
import type { SendQueue } from '../queue';

/** What only the desktop app provides. Each is optional so tests can run the server without them. */
export interface AppHooks {
  extensionDir: string | null;
  /** Called by the Control Center's Quit button. */
  onQuit?: () => void;
  /** Persists config changes (e.g. reset keys). */
  saveConfig?: (cfg: HelperConfig) => void;
  /** Shows a folder in the system file manager. */
  openFolder?: (dir: string) => void;
}

/** Everything a request handler needs. */
export interface Ctx {
  cfg: HelperConfig;
  app: AppHooks;
  link: ExtensionLink;
  queue: SendQueue;
  /** In-flight /bridge sends by request id, so /bridge/cancel/:id can stop them. */
  inflight: Map<string, AbortController>;
}

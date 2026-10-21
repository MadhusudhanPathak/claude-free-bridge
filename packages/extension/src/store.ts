// Persistent extension state. chrome.storage.local survives browser restarts (connection
// settings); chrome.storage.session lasts until the browser closes (account cache, activity).
import { AccountInfo, DEFAULT_HELPER_URL, DEFAULT_SETTINGS, ExtensionSettings } from '../../shared/src/protocol';
import type { ActivityEntry } from './messages';

export interface Connection {
  helperUrl: string;
  pairingToken: string;
  /** False after the user clicks Disconnect; stops automatic reconnects. */
  enabled: boolean;
  /** Stable id for this browser profile's install, so the helper can tell reconnects from a second browser. */
  instanceId: string;
  /** Set when the app refused `token`; that code isn't retried automatically. */
  refused: { token: string; state: 'wrong-code' | 'rejected'; message: string } | null;
}

const MAX_ACTIVITY = 50;

export async function getConnection(): Promise<Connection> {
  const stored = (await chrome.storage.local.get('connection')).connection as Partial<Connection> | undefined;
  const conn: Connection = {
    helperUrl: stored?.helperUrl || DEFAULT_HELPER_URL,
    pairingToken: stored?.pairingToken || '',
    enabled: stored?.enabled ?? true,
    instanceId: stored?.instanceId || crypto.randomUUID(),
    refused: stored?.refused ?? null,
  };
  if (!stored?.instanceId) await chrome.storage.local.set({ connection: conn });
  return conn;
}

export async function setConnection(patch: Partial<Connection>): Promise<Connection> {
  const conn = { ...(await getConnection()), ...patch };
  await chrome.storage.local.set({ connection: conn });
  return conn;
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = (await chrome.storage.local.get('settings')).settings as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export interface CachedLogin {
  loggedIn: boolean;
  account: AccountInfo | null;
}

export async function getCachedLogin(): Promise<CachedLogin> {
  const { login } = await chrome.storage.session.get('login');
  return (login as CachedLogin) ?? { loggedIn: false, account: null };
}

export async function setCachedLogin(login: CachedLogin): Promise<void> {
  await chrome.storage.session.set({ login });
}

export async function getActivity(): Promise<ActivityEntry[]> {
  const { activity } = await chrome.storage.session.get('activity');
  return (activity as ActivityEntry[]) ?? [];
}

let activityWrites: Promise<void> = Promise.resolve();

export function addActivity(entry: ActivityEntry): Promise<void> {
  // Serialize read-modify-write so concurrent jobs don't drop each other's entries.
  activityWrites = activityWrites
    .then(async () => {
      const list = [entry, ...(await getActivity())].slice(0, MAX_ACTIVITY);
      await chrome.storage.session.set({ activity: list });
    })
    .catch(() => undefined);
  return activityWrites;
}

export async function clearActivity(): Promise<void> {
  await chrome.storage.session.set({ activity: [] });
}

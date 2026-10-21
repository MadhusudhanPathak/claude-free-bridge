// Messages inside the extension: service worker ↔ claude.ai content script, and
// service worker ↔ side panel. (Helper ↔ extension frames live in shared/protocol.ts.)
import type {
  ApiChats,
  BridgeError,
  ExtensionSettings,
  ExtensionStatus,
  OpMap,
  SendParams,
  SendResult,
} from '../../shared/src/protocol';

export const JOB_PORT = 'cfb-job';
export const PANEL_PORT = 'cfb-panel';

/** Operations the content script can run against claude.ai's API. */
export type TabOpMap = Omit<OpMap, 'status'> & {
  account: { params: { orgHint?: string }; result: NonNullable<ExtensionStatus['account']> };
};
export type TabOp = keyof TabOpMap;

export type TabRun = {
  [K in TabOp]: { type: 'run'; op: K; params: TabOpMap[K]['params']; orgId: string; apiChats: ApiChats };
}[TabOp];

export type TabReply =
  | { type: 'chunk'; text: string }
  | { type: 'result'; ok: true; data: unknown }
  | { type: 'result'; ok: false; error: BridgeError };

export type HelperState = 'unpaired' | 'wrong-code' | 'connecting' | 'connected' | 'disconnected' | 'rejected' | 'off';

export interface ActivityEntry {
  at: number;
  source: 'helper' | 'panel';
  op: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface PanelState {
  version: string;
  helper: { state: HelperState; message: string; url: string; paired: boolean };
  status: ExtensionStatus;
  activity: ActivityEntry[];
  activeJobs: number;
}

export type PanelCommand =
  | { cmd: 'saveConnection'; url: string; token: string }
  | { cmd: 'disconnect' }
  | { cmd: 'reconnect' }
  | { cmd: 'saveSettings'; settings: ExtensionSettings }
  | { cmd: 'refreshAccount' }
  | { cmd: 'openClaude' }
  | { cmd: 'testSend'; params: Pick<SendParams, 'text' | 'conversationId'> }
  | { cmd: 'testCancel' }
  | { cmd: 'clearActivity' };

export type PanelEvent =
  | { type: 'state'; state: PanelState }
  | { type: 'testChunk'; text: string }
  | { type: 'testDone'; result: SendResult }
  | { type: 'testError'; error: BridgeError };

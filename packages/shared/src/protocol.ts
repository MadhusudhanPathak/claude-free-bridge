// Types shared by the helper (Node) and the extension (browser). Every WebSocket frame between
// the two is defined here, so the sides can't drift apart.

export const BRIDGE_VERSION = __VERSION__;
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8080;
export const DEFAULT_HELPER_URL = `ws://127.0.0.1:${DEFAULT_PORT}/ext`;

/** WebSocket close codes the helper uses when it turns a connection away. */
export const CloseCode = {
  BadToken: 4001,
  Busy: 4002,
  ProtocolMismatch: 4003,
  Replaced: 4004,
  TooManyAttempts: 4005,
} as const;

export type ErrorCode =
  | 'AUTH_INVALID'
  | 'NO_WORKER_TAB'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXTENSION_DISCONNECTED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND';

export interface BridgeError {
  code: ErrorCode;
  message: string;
  /** Seconds until a rate limit resets, when claude.ai says. */
  retryAfter?: number;
}

export interface OrgInfo {
  id: string;
  name: string;
  plan: string;
}

export interface AccountInfo {
  email: string | null;
  name: string | null;
  org: OrgInfo;
  orgs: OrgInfo[];
}

export type ApiChats = 'keep' | 'delete';

export interface ExtensionSettings {
  /** What to do with chats created for OpenAI/Anthropic-compatible requests. */
  apiChats: ApiChats;
  /** claude.ai model ids that requests may select; anything else uses the account default. */
  models: string[];
  /** Organization to use; empty means the one claude.ai last used. */
  orgId: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiChats: 'keep',
  models: [],
  orgId: '',
};

export interface ExtensionStatus {
  loggedIn: boolean;
  /** Null while logged out, or before a claude.ai tab has been available to read it from. */
  account: AccountInfo | null;
  settings: ExtensionSettings;
}

export interface ConversationSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  url: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  parentId: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}

export interface SendParams {
  /** Send into this existing chat. Omit to start a new one. */
  conversationId?: string;
  text: string;
  model?: string;
  /** Name for a newly created chat. */
  newChatName?: string;
  /** 'api' requests follow the "API chats" setting; 'bridge' and 'panel' chats are always kept. */
  source: 'api' | 'bridge' | 'panel';
}

export interface SendResult {
  conversationId: string;
  url: string;
  messageId: string | null;
  text: string;
  stopReason: string | null;
  /** True when the chat was deleted afterwards because of the "API chats" setting. */
  deleted: boolean;
}

export interface OpMap {
  send: { params: SendParams; result: SendResult };
  listConversations: { params: { limit?: number; offset?: number }; result: ConversationSummary[] };
  getConversation: { params: { id: string }; result: ConversationDetail };
  createConversation: { params: { name?: string; model?: string }; result: ConversationSummary };
  deleteConversation: { params: { id: string }; result: { deleted: true } };
  /** Re-reads login/account from claude.ai (opens the worker tab if needed). */
  status: { params: Record<string, never>; result: ExtensionStatus };
}

export type Op = keyof OpMap;

export type RequestFrame = {
  [K in Op]: { type: 'request'; id: string; op: K; params: OpMap[K]['params'] };
}[Op];

export type HelperToExtension =
  | RequestFrame
  | { type: 'cancel'; id: string }
  | { type: 'welcome'; helperVersion: string }
  | { type: 'pong' };

export type ExtensionToHelper =
  | {
      type: 'hello';
      token: string;
      protocol: number;
      instanceId: string;
      version: string;
      browser: string;
      status: ExtensionStatus;
    }
  | { type: 'chunk'; id: string; text: string }
  | { type: 'result'; id: string; ok: true; data: unknown }
  | { type: 'result'; id: string; ok: false; error: BridgeError }
  | { type: 'status'; status: ExtensionStatus }
  | { type: 'ping' };

export function conversationUrl(id: string): string {
  return `https://claude.ai/chat/${id}`;
}

import {
  type ConversationDetail,
  type ConversationMessage,
  type ConversationSummary,
  conversationUrl,
} from '../../../shared/src/protocol';
import { resolveOrg } from './account';
import { json, request } from './http';

interface RawMessage {
  uuid: string;
  sender: 'human' | 'assistant';
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  created_at: string;
  parent_message_uuid?: string | null;
}

interface RawConversation {
  uuid: string;
  name?: string;
  created_at: string;
  updated_at: string;
  model?: string | null;
  current_leaf_message_uuid?: string | null;
  chat_messages?: RawMessage[];
}

function toSummary(c: RawConversation): ConversationSummary {
  return {
    id: c.uuid,
    name: c.name ?? '',
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    model: c.model ?? null,
    url: conversationUrl(c.uuid),
  };
}

function messageText(m: RawMessage): string {
  const blocks = (m.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string');
  return blocks.length ? blocks.map((b) => b.text).join('\n\n') : (m.text ?? '');
}

/** The messages on the chat's current branch (claude.ai keeps edits and retries as a tree). */
export function currentBranch(c: RawConversation): RawMessage[] {
  const all = c.chat_messages ?? [];
  const byId = new Map(all.map((m) => [m.uuid, m]));
  const leaf = c.current_leaf_message_uuid ? byId.get(c.current_leaf_message_uuid) : undefined;
  if (!leaf) return [...all].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const branch: RawMessage[] = [];
  for (let m: RawMessage | undefined = leaf; m; m = m.parent_message_uuid ? byId.get(m.parent_message_uuid) : undefined) {
    branch.push(m);
    if (branch.length > all.length) break; // guards against cycles
  }
  return branch.reverse();
}

export function rawConversation(org: string, id: string): Promise<RawConversation> {
  return json<RawConversation>(`/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`);
}

export async function listConversations(orgId: string, p: { limit?: number; offset?: number }): Promise<ConversationSummary[]> {
  const org = await resolveOrg(orgId);
  const q = new URLSearchParams({ limit: String(p.limit ?? 30), offset: String(p.offset ?? 0) });
  const raw = await json<RawConversation[] | { data?: RawConversation[] }>(`/organizations/${org}/chat_conversations?${q}`);
  const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
  return list.map(toSummary);
}

export async function getConversation(orgId: string, id: string): Promise<ConversationDetail> {
  const org = await resolveOrg(orgId);
  const c = await rawConversation(org, id);
  const messages: ConversationMessage[] = currentBranch(c).map((m) => ({
    id: m.uuid,
    role: m.sender === 'human' ? 'user' : 'assistant',
    text: messageText(m),
    createdAt: m.created_at,
    parentId: m.parent_message_uuid ?? null,
  }));
  return { ...toSummary(c), messages };
}

export async function createConversation(orgId: string, p: { name?: string; model?: string }): Promise<ConversationSummary> {
  const org = await resolveOrg(orgId);
  const c = await json<RawConversation>(`/organizations/${org}/chat_conversations`, {
    method: 'POST',
    body: {
      uuid: crypto.randomUUID(),
      name: p.name ?? '',
      ...(p.model ? { model: p.model } : {}),
      include_conversation_preferences: true,
    },
  });
  return toSummary(c);
}

export async function deleteConversation(orgId: string, id: string): Promise<{ deleted: true }> {
  const org = await resolveOrg(orgId);
  await request(`/organizations/${org}/chat_conversations/${id}`, { method: 'DELETE' });
  return { deleted: true };
}

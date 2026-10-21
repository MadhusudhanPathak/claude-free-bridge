// Sending a message and reading claude.ai's streamed reply.
import { BridgeFailure } from '../../../shared/src/errors';
import { type ApiChats, conversationUrl, type SendParams, type SendResult } from '../../../shared/src/protocol';
import { readSseEvents } from '../../../shared/src/sse';
import { firstLine } from '../../../shared/src/text';
import { resolveOrg } from './account';
import { createConversation, currentBranch, deleteConversation, rawConversation } from './conversations';
import { request, secondsUntilReset } from './http';

/** Parent id the web app uses for the first message of a chat. */
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

type Reply = Pick<SendResult, 'text' | 'messageId' | 'stopReason'>;

/** The fields of claude.ai's completion stream events that the parser reads. */
interface StreamEvent {
  type?: string;
  index?: number;
  message?: { uuid?: string; id?: string };
  content_block?: { type?: string; text?: unknown };
  delta?: { type?: string; text?: unknown; stop_reason?: string | null };
  completion?: unknown;
  stop_reason?: string | null;
  uuid?: string;
  id?: string;
  error?: { type?: string; message?: string };
}

function streamError(err: StreamEvent['error'], raw: string): BridgeFailure {
  const type = err?.type ?? '';
  const message = err?.message ?? 'Unknown error from claude.ai';
  if (type === 'rate_limit_error' || /exceeded_limit/.test(raw)) {
    return new BridgeFailure('RATE_LIMITED', `claude.ai usage limit reached: ${message}`, secondsUntilReset(raw));
  }
  if (type === 'authentication_error' || type === 'permission_error') return new BridgeFailure('AUTH_INVALID', message);
  if (type === 'overloaded_error') return new BridgeFailure('UPSTREAM_ERROR', 'claude.ai is overloaded right now; try again shortly');
  return new BridgeFailure('UPSTREAM_ERROR', `claude.ai error: ${message}`);
}

/**
 * Parses the completion SSE stream: the current "messages" format (content_block_delta /
 * text_delta, skipping thinking and tool blocks) and the older { type: "completion" } format.
 */
export async function readCompletionStream(res: Response, onChunk: (text: string) => void): Promise<Reply> {
  if (!res.body) throw new BridgeFailure('UPSTREAM_ERROR', 'claude.ai returned no response body');
  const blockTypes = new Map<number | undefined, string>();
  let text = '';
  let messageId: string | null = null;
  let stopReason: string | null = null;

  const emit = (t: unknown) => {
    if (typeof t !== 'string' || !t) return;
    text += t;
    onChunk(t);
  };

  for await (const { data } of readSseEvents(res.body)) {
    if (data === '[DONE]') continue;
    let d: StreamEvent | null;
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof d !== 'object' || d === null) continue;
    switch (d.type) {
      case 'message_start':
        messageId = d.message?.uuid ?? d.message?.id ?? messageId;
        break;
      case 'content_block_start':
        blockTypes.set(d.index, d.content_block?.type ?? 'text');
        if (d.content_block?.type === 'text') emit(d.content_block.text);
        break;
      case 'content_block_delta':
        if (d.delta?.type === 'text_delta' && (blockTypes.get(d.index) ?? 'text') === 'text') emit(d.delta.text);
        break;
      case 'message_delta':
        stopReason = d.delta?.stop_reason ?? stopReason;
        break;
      case 'completion':
        emit(d.completion);
        stopReason = d.stop_reason ?? stopReason;
        messageId = messageId ?? d.uuid ?? d.id ?? null;
        break;
      case 'error':
        throw streamError(d.error, data);
      default:
        break; // ping, message_limit, content_block_stop, message_stop, …
    }
  }

  if (!text && !stopReason) throw new BridgeFailure('UPSTREAM_ERROR', 'claude.ai ended the reply without any text');
  return { text, messageId, stopReason };
}

/**
 * Sends `p.text` into an existing chat, or a new one, streaming the reply to `onChunk`.
 * A new chat is deleted again if its first message fails, or afterwards when `apiChats`
 * says so for API requests.
 */
export async function send(
  orgId: string,
  apiChats: ApiChats,
  p: SendParams,
  onChunk: (text: string) => void,
  signal: AbortSignal
): Promise<SendResult> {
  const org = await resolveOrg(orgId);
  let conversationId = p.conversationId;
  let created = false;
  let parent = ROOT_PARENT;

  if (conversationId) {
    const c = await rawConversation(org, conversationId);
    const branch = currentBranch(c);
    parent = c.current_leaf_message_uuid || branch[branch.length - 1]?.uuid || ROOT_PARENT;
  } else {
    const c = await createConversation(org, { name: p.newChatName ?? firstLine(p.text, 60), model: p.model });
    conversationId = c.id;
    created = true;
  }

  let reply: Reply;
  try {
    const res = await request(`/organizations/${org}/chat_conversations/${conversationId}/completion`, {
      method: 'POST',
      accept: 'text/event-stream',
      signal,
      body: {
        prompt: p.text,
        parent_message_uuid: parent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: navigator.language || 'en-US',
        ...(p.model ? { model: p.model } : {}),
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: 'messages',
      },
    });
    reply = await readCompletionStream(res, onChunk);
  } catch (e) {
    if (created && !signal.aborted) await deleteConversation(org, conversationId).catch(() => undefined);
    throw e;
  }

  let deleted = false;
  if (created && p.source === 'api' && apiChats === 'delete') {
    deleted = await deleteConversation(org, conversationId).then(
      () => true,
      () => false
    );
  }
  return { conversationId, url: conversationUrl(conversationId), deleted, ...reply };
}

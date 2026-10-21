// Anthropic Messages–compatible subset: GET /v1/models, POST /v1/messages.
import type * as http from 'http';
import { toBridgeError } from '../../../shared/src/errors';
import type { BridgeError, ErrorCode, SendParams } from '../../../shared/src/protocol';
import { log } from '../logger';
import type { Ctx } from './context';
import { abortOnClientGone, badRequest, LazySse, randomId, sendError, sendJson } from './io';
import { DEFAULT_MODEL_ID, echoedModel, listedModels, pickModel } from './models';
import { buildPrompt, chatName, estimateTokens, Turn } from './prompt';

const ERROR_TYPES: Partial<Record<ErrorCode, string>> = {
  AUTH_INVALID: 'authentication_error',
  RATE_LIMITED: 'rate_limit_error',
  BAD_REQUEST: 'invalid_request_error',
  NOT_FOUND: 'not_found_error',
  EXTENSION_DISCONNECTED: 'overloaded_error',
  NO_WORKER_TAB: 'overloaded_error',
};

function errorBody(err: BridgeError) {
  return { type: 'error', error: { type: ERROR_TYPES[err.code] ?? 'api_error', message: err.message } };
}

export function anthropicError(res: http.ServerResponse, e: unknown): void {
  sendError(res, e, errorBody);
}

export function anthropicModels(ctx: Ctx, res: http.ServerResponse): void {
  const data = listedModels(ctx).map((id) => ({
    type: 'model',
    id,
    display_name: id === DEFAULT_MODEL_ID ? 'claude.ai default model' : id,
    created_at: '1970-01-01T00:00:00Z',
  }));
  sendJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown; is_error?: unknown };

function blocksToText(content: unknown, where: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw badRequest(`${where}: "content" must be a string or an array of blocks`);
  const out: string[] = [];
  for (const b of content as Array<Block | null>) {
    switch (b?.type) {
      case 'text':
        if (typeof b.text !== 'string') throw badRequest(`${where}: text block without "text"`);
        out.push(b.text);
        break;
      case 'tool_use':
        out.push(`[Called tool ${String(b.name)} with ${JSON.stringify(b.input ?? {})}]`);
        break;
      case 'tool_result':
        out.push(`[Tool result${b.is_error ? ' (error)' : ''}]\n${b.content == null ? '' : blocksToText(b.content, where)}`);
        break;
      case 'thinking':
      case 'redacted_thinking':
        break;
      default:
        throw badRequest(`${where}: "${String(b?.type)}" blocks are not supported yet (text only)`);
    }
  }
  return out.join('\n');
}

let warnedTools = false;

function parseRequest(body: Record<string, unknown>): { system: string; turns: Turn[] } {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw badRequest('"messages" must be a non-empty array');
  }
  if (Array.isArray(body.tools) && body.tools.length && !warnedTools) {
    warnedTools = true;
    log.warn('Request includes tool definitions; tools are ignored (text only)');
  }
  const system = body.system == null ? '' : blocksToText(body.system, 'system');
  const turns = body.messages.map((raw, i): Turn => {
    const m = raw as { role?: unknown; content?: unknown } | null;
    if (m?.role !== 'user' && m?.role !== 'assistant') {
      throw badRequest(`messages[${i}]: role must be "user" or "assistant"`);
    }
    return { role: m.role, text: blocksToText(m.content, `messages[${i}]`) };
  });
  return { system, turns };
}

function stopReason(r: string | null): string {
  return r === 'max_tokens' || r === 'stop_sequence' ? r : 'end_turn';
}

export async function anthropicMessages(ctx: Ctx, res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
  let parsed: { system: string; turns: Turn[] };
  try {
    parsed = parseRequest(body);
  } catch (e) {
    return anthropicError(res, e);
  }

  const prompt = buildPrompt(parsed.system, parsed.turns);
  const model = echoedModel(body.model);
  const params: SendParams = { text: prompt, model: pickModel(ctx, body.model), newChatName: chatName(parsed.turns), source: 'api' };
  const id = randomId('msg_');
  const inputTokens = estimateTokens(prompt);
  const { signal } = abortOnClientGone(res);

  if (!body.stream) {
    try {
      const r = await ctx.queue.enqueue(params, { signal });
      sendJson(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: r.text }],
        stop_reason: stopReason(r.stopReason),
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: estimateTokens(r.text) },
      });
    } catch (e) {
      anthropicError(res, e);
    }
    return;
  }

  const event = (data: { type: string } & Record<string, unknown>) => stream.send(data, data.type);
  const textDelta = (text: string) => event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const stream = new LazySse(res, () => {
    event({
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  });
  let output = '';

  try {
    const r = await ctx.queue.enqueue(params, {
      signal,
      onChunk: (text) => {
        output += text;
        textDelta(text);
      },
    });
    if (!output && r.text) textDelta(r.text);
    event({ type: 'content_block_stop', index: 0 });
    event({
      type: 'message_delta',
      delta: { stop_reason: stopReason(r.stopReason), stop_sequence: null },
      usage: { output_tokens: estimateTokens(output || r.text) },
    });
    event({ type: 'message_stop' });
    stream.end();
  } catch (e) {
    if (!stream.started) return anthropicError(res, e);
    stream.send(errorBody(toBridgeError(e)), 'error');
    stream.end();
  }
}

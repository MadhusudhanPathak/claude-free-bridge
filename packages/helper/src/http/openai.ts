// OpenAI Chat Completions–compatible subset: GET /v1/models, POST /v1/chat/completions.
import type * as http from 'http';
import { toBridgeError } from '../../../shared/src/errors';
import type { BridgeError, ErrorCode, SendParams } from '../../../shared/src/protocol';
import type { Ctx } from './context';
import { abortOnClientGone, badRequest, LazySse, randomId, sendError, sendJson } from './io';
import { echoedModel, listedModels, pickModel } from './models';
import { buildPrompt, chatName, estimateTokens, Turn } from './prompt';

const ERROR_TYPES: Partial<Record<ErrorCode, string>> = {
  AUTH_INVALID: 'authentication_error',
  RATE_LIMITED: 'rate_limit_error',
  BAD_REQUEST: 'invalid_request_error',
  NOT_FOUND: 'not_found_error',
};

function errorBody(err: BridgeError) {
  return { error: { message: err.message, type: ERROR_TYPES[err.code] ?? 'api_error', code: err.code } };
}

export function openAiError(res: http.ServerResponse, e: unknown): void {
  sendError(res, e, errorBody);
}

export function openAiModels(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, {
    object: 'list',
    data: listedModels(ctx).map((id) => ({ id, object: 'model', created: 0, owned_by: 'claude.ai' })),
  });
}

function textOf(content: unknown, where: string): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw badRequest(`${where}: "content" must be a string or an array of text parts`);
  return content
    .map((part) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      if ((p?.type === 'text' || p?.type === 'input_text') && typeof p.text === 'string') return p.text;
      throw badRequest(`${where}: only text content is supported (got "${String(p?.type)}")`);
    })
    .join('\n');
}

interface RawMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  name?: unknown;
}

function toolCallsText(calls: unknown): string {
  if (!Array.isArray(calls)) return '';
  return calls
    .map((c) => {
      const fn = (c as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
      const args = fn?.arguments ?? '{}';
      return `\n[Called tool ${String(fn?.name)} with ${typeof args === 'string' ? args : JSON.stringify(args)}]`;
    })
    .join('');
}

function parseMessages(body: Record<string, unknown>): { system: string; turns: Turn[] } {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw badRequest('"messages" must be a non-empty array');
  }
  const system: string[] = [];
  const turns: Turn[] = [];
  body.messages.forEach((raw, i) => {
    const m = raw as RawMessage | null;
    const where = `messages[${i}]`;
    switch (m?.role) {
      case 'system':
      case 'developer':
        system.push(textOf(m.content, where));
        break;
      case 'user':
        turns.push({ role: 'user', text: textOf(m.content, where) });
        break;
      case 'assistant':
        turns.push({ role: 'assistant', text: (textOf(m.content, where) + toolCallsText(m.tool_calls)).trim() });
        break;
      case 'tool':
      case 'function':
        turns.push({ role: 'user', text: `[Tool result${m.name ? ` from ${String(m.name)}` : ''}]\n${textOf(m.content, where)}` });
        break;
      default:
        throw badRequest(`${where}: unsupported role "${String(m?.role)}"`);
    }
  });
  if (!turns.length) throw badRequest('"messages" needs at least one user message');
  return { system: system.join('\n\n'), turns };
}

function finishReason(stopReason: string | null): string {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

export async function openAiChatCompletions(ctx: Ctx, res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
  let parsed: { system: string; turns: Turn[] };
  try {
    parsed = parseMessages(body);
  } catch (e) {
    return openAiError(res, e);
  }

  const prompt = buildPrompt(parsed.system, parsed.turns);
  const model = echoedModel(body.model);
  const params: SendParams = { text: prompt, model: pickModel(ctx, body.model), newChatName: chatName(parsed.turns), source: 'api' };
  const id = randomId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  const { signal } = abortOnClientGone(res);

  if (!body.stream) {
    try {
      const r = await ctx.queue.enqueue(params, { signal });
      const promptTokens = estimateTokens(prompt);
      const completionTokens = estimateTokens(r.text);
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: finishReason(r.stopReason) }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
    } catch (e) {
      openAiError(res, e);
    }
    return;
  }

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const stream = new LazySse(res, () => stream.send(chunk({ role: 'assistant', content: '' })));
  let streamedText = false;

  try {
    const r = await ctx.queue.enqueue(params, {
      signal,
      onChunk: (text) => {
        streamedText = true;
        stream.send(chunk({ content: text }));
      },
    });
    if (!streamedText && r.text) stream.send(chunk({ content: r.text }));
    stream.send(chunk({}, finishReason(r.stopReason)));
    stream.send('[DONE]');
    stream.end();
  } catch (e) {
    if (!stream.started) return openAiError(res, e);
    stream.send(errorBody(toBridgeError(e)));
    stream.send('[DONE]');
    stream.end();
  }
}

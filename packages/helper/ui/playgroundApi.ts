// What the Playground sends and receives in each API mode. Pure functions, no DOM.
import type { SendResult } from '../../shared/src/protocol';
import type { SseEvent } from '../../shared/src/sse';

export type Mode = 'openai' | 'anthropic' | 'bridge';

export const MODES: readonly Mode[] = ['openai', 'anthropic', 'bridge'];

export const DEFAULT_MODEL = 'claude-web';

interface RequestInput {
  mode: Mode;
  text: string;
  /** Earlier turns, resent by the OpenAI and Anthropic modes. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: string;
  system: string;
  stream: boolean;
  /** The claude.ai chat to continue (bridge mode); null starts a new one. */
  chatId: string | null;
}

interface StreamUpdate {
  text?: string;
  error?: string;
  result?: SendResult;
}

interface ErrorShape {
  code?: string;
  type?: string;
  message?: string;
}

interface ReplyJson {
  error?: ErrorShape;
  type?: string;
  text?: string;
  delta?: { text?: string };
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  content?: Array<{ text?: string }>;
}

export function buildRequest(input: RequestInput): { path: string; body: Record<string, unknown> } {
  const { mode, text, model, stream, system } = input;
  const turns = [...input.history, { role: 'user' as const, content: text }];

  switch (mode) {
    case 'openai':
      return {
        path: '/v1/chat/completions',
        body: { model, stream, messages: system ? [{ role: 'system', content: system }, ...turns] : turns },
      };
    case 'anthropic':
      return {
        path: '/v1/messages',
        body: { model, max_tokens: 4096, stream, ...(system ? { system } : {}), messages: turns },
      };
    case 'bridge': {
      const body: Record<string, unknown> = { text, stream };
      if (model !== DEFAULT_MODEL) body.model = model;
      return input.chatId
        ? { path: `/bridge/conversations/${encodeURIComponent(input.chatId)}/messages`, body }
        : { path: '/bridge/messages', body };
    }
  }
}

function parse(data: string): ReplyJson | null {
  try {
    const j: unknown = JSON.parse(data);
    return typeof j === 'object' && j !== null ? (j as ReplyJson) : null;
  } catch {
    return null;
  }
}

/** Interprets one streamed event. */
export function readEvent(mode: Mode, ev: SseEvent): StreamUpdate {
  if (ev.data === '[DONE]') return {};
  const j = parse(ev.data);
  if (!j) return {};
  switch (mode) {
    case 'openai':
      if (j.error) return { error: `${j.error.code ?? 'error'}: ${j.error.message}` };
      return { text: j.choices?.[0]?.delta?.content ?? undefined };
    case 'anthropic':
      if (ev.event === 'error' || j.type === 'error') return { error: `${j.error?.type ?? 'error'}: ${j.error?.message}` };
      return j.type === 'content_block_delta' ? { text: j.delta?.text } : {};
    case 'bridge':
      if (ev.event === 'chunk') return { text: j.text };
      if (ev.event === 'done') return { result: j as unknown as SendResult };
      if (ev.event === 'error') return { error: `${j.error?.code ?? 'error'}: ${j.error?.message}` };
      return {};
  }
}

/** The reply text of a non-streamed response. */
export function fullText(mode: Mode, json: unknown): string {
  const j = (json ?? {}) as ReplyJson;
  switch (mode) {
    case 'openai':
      return j.choices?.[0]?.message?.content ?? '';
    case 'anthropic':
      return (j.content ?? []).map((b) => b.text ?? '').join('');
    case 'bridge':
      return j.text ?? '';
  }
}

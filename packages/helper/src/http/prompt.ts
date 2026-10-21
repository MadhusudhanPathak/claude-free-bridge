// claude.ai takes one user message at a time, but the OpenAI/Anthropic APIs are stateless and
// resend the whole conversation on every call. This flattens system text and history into a
// single prompt for a fresh claude.ai chat.
import { firstLine } from '../../../shared/src/text';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

function renderHistory(turns: Turn[]): string {
  const body = turns.map((t) => `<message role="${t.role}">\n${t.text}\n</message>`).join('\n');
  return `<conversation_history>\n${body}\n</conversation_history>`;
}

/** Builds the claude.ai message for `turns` (which must not be empty). */
export function buildPrompt(system: string, turns: Turn[]): string {
  const sys = system.trim();
  const last = turns[turns.length - 1];

  // One user message and nothing else: send it as-is.
  if (turns.length === 1 && last.role === 'user' && !sys) return last.text;

  const parts: string[] = [];
  if (sys) parts.push(`<system_instructions>\n${sys}\n</system_instructions>`);

  if (last.role === 'user') {
    const history = turns.slice(0, -1);
    if (history.length) {
      parts.push(renderHistory(history));
      parts.push(
        'Reply to the following message as the assistant, continuing the conversation above. ' +
          'Reply directly, without a role label or XML tags.\n\n' +
          last.text
      );
    } else {
      parts.push(last.text);
    }
  } else {
    // The client ended on an assistant turn (a "prefill"): ask Claude to continue it.
    parts.push(renderHistory(turns));
    parts.push(
      'Continue the last assistant message exactly from where it stops. Output only the continuation, ' +
        'without repeating what is already there and without a role label or XML tags.'
    );
  }
  return parts.join('\n\n');
}

/** Name for the claude.ai chat an API request creates, so it's easy to spot in the sidebar. */
export function chatName(turns: Turn[]): string {
  const lastUser = [...turns].reverse().find((t) => t.role === 'user')?.text ?? '';
  return `API · ${firstLine(lastUser, 50) || 'request'}`;
}

/** Rough token count for `usage` fields; claude.ai doesn't report real ones. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

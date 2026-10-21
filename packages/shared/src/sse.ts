export interface SseEvent {
  event?: string;
  data: string;
}

function parseEvent(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
  const data = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  return data ? { event, data } : null;
}

/**
 * Reads a server-sent events body and yields each event that carries data. `onText` receives
 * the raw text as it arrives. Stopping early cancels the rest of the body.
 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>, onText?: (text: string) => void): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      finished = done;
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (text) {
        onText?.(text);
        buffer += text;
      }
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buffer))) {
        const ev = parseEvent(buffer.slice(0, m.index));
        buffer = buffer.slice(m.index + m[0].length);
        if (ev) yield ev;
      }
    }
    const last = parseEvent(buffer);
    if (last) yield last;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
  }
}

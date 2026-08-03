export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp?: string;
}

interface ContextComposerOptions {
  maxTurns?: number;
}

interface CachedFile {
  hash: string;
  content: string;
}

function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (((hash << 5) - hash) + s.charCodeAt(i)) | 0;
  return String(hash >>> 0);
}

/** Tracks conversation history for a single agent run and keeps it bounded via naive summarization. */
export class ContextComposer {
  private messages: Message[] = [];
  private fileCache = new Map<string, CachedFile>();
  private readonly maxTurns: number;

  constructor(opts?: ContextComposerOptions) {
    this.maxTurns = opts?.maxTurns ?? 12;
  }

  addSystemMessage(text: string): void {
    this.messages.push({ role: 'system', content: text, timestamp: new Date().toISOString() });
  }

  addUserMessage(text: string): void {
    this.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    this.maybeSummarize();
  }

  addAssistantMessage(text: string): void {
    this.messages.push({ role: 'assistant', content: text, timestamp: new Date().toISOString() });
    this.maybeSummarize();
  }

  addToolResult(text: string): void {
    this.messages.push({ role: 'tool', content: text, timestamp: new Date().toISOString() });
    this.maybeSummarize();
  }

  /** Returns the last N turns as a flattened prompt string. */
  getContext(): string {
    return this.messages
      .slice(-this.maxTurns * 2)
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n\n');
  }

  cacheFile(path: string, content: string): boolean {
    const hash = simpleHash(content);
    const previous = this.fileCache.get(path);
    if (previous?.hash === hash) return false;
    this.fileCache.set(path, { hash, content });
    return true;
  }

  getCachedFile(path: string): string | undefined {
    return this.fileCache.get(path)?.content;
  }

  private maybeSummarize(): void {
    if (this.messages.length <= this.maxTurns * 4) return;

    const keep = this.messages.slice(-this.maxTurns * 2);
    const old = this.messages.slice(0, this.messages.length - keep.length);
    const summaryText = old.slice(0, 6).map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n---\n');
    const summaryMessage: Message = {
      role: 'system',
      content: `Previous conversation summary:\n${summaryText}`,
      timestamp: new Date().toISOString(),
    };
    this.messages = [summaryMessage, ...keep];
  }
}

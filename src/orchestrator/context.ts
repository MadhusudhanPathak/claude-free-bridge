export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; timestamp?: string }

export class ContextComposer {
  private messages: Message[] = [];
  private fileCache: Map<string, {hash:string, content:string}> = new Map();
  private maxTurns = 12;

  constructor(opts?: { maxTurns?: number }) {
    if (opts?.maxTurns) this.maxTurns = opts.maxTurns;
  }

  addSystemMessage(text: string) {
    this.messages.push({ role: 'system', content: text, timestamp: new Date().toISOString() });
  }
  addUserMessage(text: string) {
    this.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    this.maybeSummarize();
  }
  addAssistantMessage(text: string) {
    this.messages.push({ role: 'assistant', content: text, timestamp: new Date().toISOString() });
    this.maybeSummarize();
  }
  addToolResult(text: string) {
    this.messages.push({ role: 'tool', content: text, timestamp: new Date().toISOString() });
    this.maybeSummarize();
  }

  getContext() {
    // Return last N turns, with a summary placeholder for older history
    const relevant = this.messages.slice(-this.maxTurns * 2);
    return relevant.map(m => `[${m.role}] ${m.content}`).join('\n\n');
  }

  cacheFile(path: string, content: string) {
    const h = simpleHash(content);
    const prev = this.fileCache.get(path);
    if (!prev || prev.hash !== h) {
      this.fileCache.set(path, { hash: h, content });
      return true;
    }
    return false;
  }

  getCachedFile(path: string) {
    return this.fileCache.get(path)?.content;
  }

  private maybeSummarize() {
    // If messages exceed a threshold, produce a naive summary and replace older messages with the summary
    if (this.messages.length <= this.maxTurns * 4) return;
    const keep = this.messages.slice(-this.maxTurns * 2);
    const old = this.messages.slice(0, this.messages.length - keep.length);
    // Naive summary: join first 6 messages
    const summaryText = old.slice(0, 6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n---\n');
    const summaryMsg: Message = { role: 'system', content: `Previous conversation summary:\n${summaryText}`, timestamp: new Date().toISOString() };
    this.messages = [summaryMsg, ...keep];
  }
}

function simpleHash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return String(h >>> 0);
}

import { sendPromptViaPlaywright } from '../transport/playwright';
import { parseToolUses } from '../parser/xml';
import { executeTool } from '../tools/registry';
import { ContextComposer } from './context';
import { appendMessage, createConversation, initPersistence } from '../db/sqlite';
import { info } from '../logger';

export interface AgentLoopOptions {
  workspace?: string;
  yes?: boolean;
}

export async function agentLoop(task: string, opts: AgentLoopOptions = {}): Promise<void> {
  info('Agent loop started. Task:', task);
  const workspace = opts.workspace ?? '.';

  const store = await initPersistence();
  const conversationId = `local-${Date.now()}`;
  await createConversation(store, conversationId, task);

  const context = new ContextComposer({ maxTurns: 12 });
  context.addSystemMessage('System: Claude-Free-Bridge');
  context.addUserMessage(task);
  await appendMessage(store, conversationId, 'user', task);

  const response = await sendPromptViaPlaywright(context.getContext());
  info('Assistant response (scraped):', response);
  context.addAssistantMessage(response);
  await appendMessage(store, conversationId, 'assistant', response);

  const tools = parseToolUses(response);
  if (tools.length === 0) {
    info('No tool_use blocks found. Done.');
    return;
  }

  // MVP: execute tool calls sequentially and stop after one pass (no follow-up turn).
  for (const tool of tools) {
    info('Executing tool:', tool.tool_name, tool.parameters);
    const result = await executeTool(tool, workspace, { yes: !!opts.yes });
    info('Tool result:', result);
    const resultJson = JSON.stringify(result);
    context.addToolResult(resultJson);
    await appendMessage(store, conversationId, 'tool', resultJson);
  }
}

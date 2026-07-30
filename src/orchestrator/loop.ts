import { sendPromptViaPlaywright } from '../transport/playwright';
import { parseToolUses } from '../parser/xml';
import { executeTool } from '../tools/registry';
import { ContextComposer } from './context';
import { initPersistence, createConversation, appendMessage } from '../db/sqlite';

export async function agentLoop(task: string, opts: { workspace?: string; yes?: boolean } = {}) {
  console.log('Agent loop started. Task:', task);
  const workspace = opts.workspace ?? '.';

  const store = await initPersistence();
  const convoId = `local-${Date.now()}`;
  await createConversation(store, convoId, task);

  const ctx = new ContextComposer({ maxTurns: 12 });
  ctx.addSystemMessage('System: Claude-Free-Bridge');
  ctx.addUserMessage(task);
  await appendMessage(store, convoId, 'user', task);

  // Build prompt from context
  const prompt = ctx.getContext();

  // Send prompt and get a scraped response
  const response = await sendPromptViaPlaywright(prompt);
  console.log('Assistant response (scraped):');
  console.log(response);
  ctx.addAssistantMessage(response);
  await appendMessage(store, convoId, 'assistant', response);

  // Parse for tool uses
  const tools = parseToolUses(response);
  if (tools.length === 0) {
    console.log('No tool_use blocks found. Done.');
    return;
  }

  // Execute sequentially using registry
  for (const t of tools) {
    console.log('Executing tool:', t.tool_name, t.parameters || {});
    const result = await executeTool(t, workspace, { yes: !!opts.yes });
    console.log('Tool result:', JSON.stringify(result, null, 2));
    ctx.addToolResult(JSON.stringify(result));
    await appendMessage(store, convoId, 'tool', JSON.stringify(result));
  }

  // Optionally send tool results back and continue loop (MVP: single iteration)
}

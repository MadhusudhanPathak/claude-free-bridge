import type { ToolUse } from '../parser/xml';
import { listDirTool, readFileTool, writeFileTool } from './fs';
import { applyDiff } from './diff';
import { runShellCommand } from './shell';

export interface ExecuteToolOptions {
  yes?: boolean;
  force?: boolean;
  timeout?: number;
}

export interface ToolExecutionResult {
  tool_name: string;
  status: 'success' | 'error';
  [key: string]: unknown;
}

export async function executeTool(toolUse: ToolUse, workspace = '.', opts: ExecuteToolOptions = {}): Promise<ToolExecutionResult> {
  const { tool_name: name, parameters: params = {} } = toolUse;

  try {
    switch (name) {
      case 'read_file': {
        const content = await readFileTool(
          params.path,
          workspace,
          params.offset ? Number(params.offset) : undefined,
          params.limit ? Number(params.limit) : undefined
        );
        return { tool_name: name, status: 'success', content };
      }
      case 'list_dir': {
        const tree = await listDirTool(params.path || '.', workspace, params.recursive === 'true');
        return { tool_name: name, status: 'success', tree };
      }
      case 'write_file': {
        const result = await writeFileTool(params.path, params.content, workspace, opts);
        return { tool_name: name, status: 'success', bytes_written: result };
      }
      case 'apply_diff': {
        const result = await applyDiff(params.path, params.diff, workspace);
        return { tool_name: name, status: result.ok ? 'success' : 'error', detail: result };
      }
      case 'run_shell': {
        const result = await runShellCommand(params.command, workspace, opts);
        return { tool_name: name, status: result.ok ? 'success' : 'error', ...result };
      }
      default:
        return { tool_name: name, status: 'error', error: 'unknown_tool' };
    }
  } catch (err) {
    return { tool_name: name, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

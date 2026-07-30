import { readFileTool, listDirTool, writeFileTool } from './fs';
import { applyDiff } from './diff';
import { runShellCommand } from './shell';

export async function executeTool(toolUse: any, workspace = '.', opts: any = {}) {
  const name = toolUse.tool_name;
  const params = toolUse.parameters || {};
  try {
    switch (name) {
      case 'read_file': {
        const content = await readFileTool(params.path, workspace, params.offset ? Number(params.offset) : undefined, params.limit ? Number(params.limit) : undefined);
        return { tool_name: name, status: 'success', content };
      }
      case 'list_dir': {
        const tree = await listDirTool(params.path || '.', workspace, params.recursive === 'true' || params.recursive === true);
        return { tool_name: name, status: 'success', tree };
      }
      case 'write_file': {
        const res = await writeFileTool(params.path, params.content, workspace, opts);
        return { tool_name: name, status: 'success', bytes_written: res };
      }
      case 'apply_diff': {
        const res = await applyDiff(params.path, params.diff, workspace);
        return { tool_name: name, status: res.ok ? 'success' : 'error', detail: res };
      }
      case 'run_shell': {
        const res = await runShellCommand(params.command, workspace, opts);
        return { tool_name: name, status: res.ok ? 'success' : 'error', ...res };
      }
      default:
        return { tool_name: name, status: 'error', error: 'unknown_tool' };
    }
  } catch (err: any) {
    return { tool_name: name, status: 'error', error: err?.message ?? String(err) };
  }
}

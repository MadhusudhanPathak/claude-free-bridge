import * as fs from 'fs';
import * as path from 'path';

export interface WriteFileOptions {
  force?: boolean;
  yes?: boolean;
}

export type FileTreeEntry =
  | { name: string; type: 'file'; size: number }
  | { name: string; type: 'dir'; children?: FileTreeEntry[] }
  | { name: string; type: 'unknown' };

function resolvePath(relPath: string, workspace: string): string {
  return path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath);
}

export async function readFileTool(relPath: string, workspace = '.', offset?: number, limit?: number) {
  if (!relPath) return { status: 'error' as const, error: 'path_required' };

  const abs = resolvePath(relPath, workspace);
  if (!fs.existsSync(abs)) return { status: 'error' as const, error: 'not_found' };
  if (!fs.statSync(abs).isFile()) return { status: 'error' as const, error: 'not_a_file' };

  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split(/\r?\n/);

  if (typeof offset === 'number' || typeof limit === 'number') {
    const start = Math.max(0, (offset ?? 1) - 1);
    const slice = lines.slice(start, limit ? start + limit : undefined).join('\n');
    return { status: 'success' as const, content: slice, total_lines: lines.length };
  }

  if (lines.length > 200) {
    const head = lines.slice(0, 100).join('\n');
    return { status: 'success' as const, content: `${head}\n... [truncated, ${lines.length} lines total] ...`, total_lines: lines.length };
  }

  return { status: 'success' as const, content };
}

function walkDirectory(dir: string, recursive: boolean): FileTreeEntry[] {
  return fs.readdirSync(dir).map((name): FileTreeEntry => {
    try {
      const entryPath = path.join(dir, name);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        return { name, type: 'dir', children: recursive ? walkDirectory(entryPath, recursive) : undefined };
      }
      return { name, type: 'file', size: stat.size };
    } catch {
      return { name, type: 'unknown' };
    }
  });
}

export async function listDirTool(relPath: string, workspace = '.', recursive = false) {
  const abs = resolvePath(relPath || '.', workspace);
  if (!fs.existsSync(abs)) return { status: 'error' as const, error: 'not_found' };
  if (!fs.statSync(abs).isDirectory()) return { status: 'error' as const, error: 'not_a_directory' };

  return { status: 'success' as const, tree: walkDirectory(abs, recursive) };
}

export async function writeFileTool(relPath: string, content: string, workspace = '.', opts: WriteFileOptions = {}) {
  if (!relPath) return { status: 'error' as const, error: 'path_required' };
  if (typeof content !== 'string') return { status: 'error' as const, error: 'content_required' };

  const abs = resolvePath(relPath, workspace);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(abs) && fs.statSync(abs).size > 0 && !opts.force && !opts.yes) {
    return { status: 'error' as const, error: 'file_exists_confirmation_required' };
  }

  fs.writeFileSync(abs, content, 'utf8');
  return { status: 'success' as const, bytes: Buffer.byteLength(content, 'utf8') };
}

import * as fs from 'fs';
import * as path from 'path';

export async function readFileTool(p: string, workspace = '.', offset?: number, limit?: number) {
  const abs = path.isAbsolute(p) ? p : path.join(workspace, p);
  if (!fs.existsSync(abs)) return { status: 'error', error: 'not_found' };
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return { status: 'error', error: 'not_a_file' };
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  if (typeof offset === 'number' || typeof limit === 'number') {
    const start = Math.max(0, (offset ?? 1) - 1);
    const slice = lines.slice(start, limit ? start + limit : undefined).join('\n');
    return { status: 'success', content: slice, total_lines: lines.length };
  }
  if (lines.length > 200) {
    const head = lines.slice(0, 100).join('\n');
    return { status: 'success', content: head + `\n... [truncated, ${lines.length} lines total] ...`, total_lines: lines.length };
  }
  return { status: 'success', content };
}

export async function listDirTool(relPath: string, workspace = '.', recursive = false) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath || '.');
  if (!fs.existsSync(abs)) return { status: 'error', error: 'not_found' };
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return { status: 'error', error: 'not_a_directory' };
  function walk(dir: string, depth = 0) {
    const items = fs.readdirSync(dir);
    const out: any[] = [];
    for (const it of items) {
      try {
        const p = path.join(dir, it);
        const s = fs.statSync(p);
        if (s.isDirectory()) {
          out.push({ name: it, type: 'dir', children: recursive ? walk(p, depth + 1) : undefined });
        } else {
          out.push({ name: it, type: 'file', size: s.size });
        }
      } catch (e) {
        out.push({ name: it, type: 'unknown' });
      }
    }
    return out;
  }
  const tree = walk(abs);
  return { status: 'success', tree };
}

export async function writeFileTool(relPath: string, content: string, workspace = '.', opts: any = {}) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0 && !opts.force && !opts.yes) {
    return { status: 'error', error: 'file_exists_confirmation_required' };
  }
  fs.writeFileSync(abs, content, 'utf8');
  return { status: 'success', bytes: Buffer.byteLength(content, 'utf8') };
}

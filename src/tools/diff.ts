import * as fs from 'fs';
import * as path from 'path';

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string;
}

type DiffResult =
  | { ok: true; applied: number; backup: string; fuzzy?: boolean }
  | { ok: false; error: string; hunk?: Hunk };

const UNIFIED_HUNK_RE = /@@\s*-(\d+),(\d+)\s*\+(\d+),(\d+)\s*@@([\s\S]*?)(?=(?:@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@)|$)/g;
const SEARCH_REPLACE_RE = /<<<<<<<\s*SEARCH\s*([\s\S]*?)=======\s*([\s\S]*?)>>>>>>>\s*REPLACE/;

function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function parseHunkLines(body: string): { oldLines: string[]; newLines: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.length) continue;
    const marker = line[0];
    const rest = line.slice(1).replace(/^\s?/, '');
    if (marker === ' ' || marker === '-') oldLines.push(rest);
    if (marker === ' ' || marker === '+') newLines.push(rest);
  }
  return { oldLines, newLines };
}

function applyUnifiedHunks(abs: string, original: string, diff: string): DiffResult {
  const origLines = original.split(/\r?\n/);
  const newLines = origLines.slice();
  const hunks: Hunk[] = [];

  UNIFIED_HUNK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNIFIED_HUNK_RE.exec(diff)) !== null) {
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: Number(match[2]),
      newStart: Number(match[3]),
      newCount: Number(match[4]),
      body: match[5],
    });
  }

  let offset = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines: newLinesFrag } = parseHunkLines(hunk.body);
    const targetIdx = hunk.oldStart - 1 + offset;
    const currentSlice = newLines.slice(targetIdx, targetIdx + hunk.oldCount);

    const matches = arraysEqual(currentSlice, oldLines) ||
      arraysEqual(currentSlice.map(normalizeWhitespace), oldLines.map(normalizeWhitespace));
    if (!matches) {
      return { ok: false, error: 'hunk_mismatch', hunk };
    }

    newLines.splice(targetIdx, hunk.oldCount, ...newLinesFrag);
    offset += newLinesFrag.length - hunk.oldCount;
  }

  const updated = newLines.join('\n');
  const backup = `${abs}.bak`;
  fs.copyFileSync(abs, backup);
  fs.writeFileSync(abs, updated, 'utf8');
  return { ok: true, applied: hunks.length, backup };
}

function applySearchReplace(abs: string, original: string, diff: string): DiffResult | null {
  const match = diff.match(SEARCH_REPLACE_RE);
  if (!match) return null;

  const oldBlock = match[1].trim();
  const newBlock = match[2].trim();
  const backup = `${abs}.bak`;

  const exactIdx = original.indexOf(oldBlock);
  if (exactIdx !== -1) {
    fs.copyFileSync(abs, backup);
    fs.writeFileSync(abs, original.replace(oldBlock, newBlock), 'utf8');
    return { ok: true, applied: 1, backup };
  }

  const normalizedPos = normalizeWhitespace(original).indexOf(normalizeWhitespace(oldBlock));
  if (normalizedPos === -1) return { ok: false, error: 'hunk_not_found' };

  const firstLine = oldBlock.split(/\r?\n/)[0].trim();
  const lastLine = oldBlock.split(/\r?\n/).slice(-1)[0].trim();
  const startIdx = original.indexOf(firstLine);
  const endIdx = original.lastIndexOf(lastLine);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return { ok: false, error: 'fuzzy_match_failed' };

  const updated = original.slice(0, startIdx) + newBlock + original.slice(endIdx + lastLine.length);
  fs.copyFileSync(abs, backup);
  fs.writeFileSync(abs, updated, 'utf8');
  return { ok: true, applied: 1, backup, fuzzy: true };
}

export async function applyDiff(relPath: string, diff: string, workspace = '.'): Promise<DiffResult> {
  if (!relPath) return { ok: false, error: 'path_required' };
  if (!diff) return { ok: false, error: 'diff_required' };

  const abs = path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };

  const original = fs.readFileSync(abs, 'utf8');

  if (UNIFIED_HUNK_RE.test(diff)) {
    return applyUnifiedHunks(abs, original, diff);
  }

  const searchReplaceResult = applySearchReplace(abs, original, diff);
  if (searchReplaceResult) return searchReplaceResult;

  return { ok: false, error: 'unsupported_diff_format' };
}

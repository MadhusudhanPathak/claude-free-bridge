import * as fs from 'fs';
import * as path from 'path';

function normalizeWhitespace(s: string) {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

export async function applyDiff(relPath: string, diff: string, workspace = '.') {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
  const original = fs.readFileSync(abs, 'utf8');
  const origLines = original.split(/\r?\n/);

  // Detect unified diff hunks @@ -l,s +l,s @@
  const unifiedRe = /@@\s*-(\d+),(\d+)\s*\+(\d+),(\d+)\s*@@([\s\S]*?)(?=(?:@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@)|$)/g;
  const hasUnified = unifiedRe.test(diff);
  if (hasUnified) {
    // Apply hunks atomically on a copy
    const newLines = origLines.slice();
    const hunks: Array<{oldStart:number, oldCount:number, newStart:number, newCount:number, body:string}> = [];
    let m: RegExpExecArray | null;
    unifiedRe.lastIndex = 0;
    while ((m = unifiedRe.exec(diff)) !== null) {
      hunks.push({
        oldStart: Number(m[1]),
        oldCount: Number(m[2]),
        newStart: Number(m[3]),
        newCount: Number(m[4]),
        body: m[5]
      });
    }

    // We'll apply hunks in order of appearance; track offset
    let offset = 0;
    for (const h of hunks) {
      // Parse hunk body lines: lines starting with ' ', '-', '+'
      const hLines = h.body.replace(/\r/g,'').split('\n').map(l => l.replace(/^\+|^-|^ /, (s) => s ? s : s));
      // Build expected old lines and new lines
      const oldLines: string[] = [];
      const newLinesFrag: string[] = [];
      const bodyLines = h.body.split('\n');
      for (const bl of bodyLines) {
        if (bl.length === 0) continue;
        const sig = bl[0];
        const rest = bl.slice(1);
        if (sig === ' ' || sig === '-') oldLines.push(rest.replace(/^\s?/, ''));
        if (sig === ' ' || sig === '+') newLinesFrag.push(rest.replace(/^\s?/, ''));
      }

      // Hunk target index in current newLines
      const targetIdx = h.oldStart - 1 + offset;
      const currentSlice = newLines.slice(targetIdx, targetIdx + h.oldCount);

      // Try exact match
      const exactMatch = arraysEqual(currentSlice, oldLines);
      if (!exactMatch) {
        // Try normalized whitespace match
        const normCurrent = currentSlice.map(normalizeWhitespace);
        const normOld = oldLines.map(normalizeWhitespace);
        if (!arraysEqual(normCurrent, normOld)) {
          return { ok: false, error: 'hunk_mismatch', hunk: h };
        }
      }

      // Apply replacement
      newLines.splice(targetIdx, h.oldCount, ...newLinesFrag);
      offset += newLinesFrag.length - h.oldCount;
    }

    const updated = newLines.join('\n');
    // Backup and write
    fs.copyFileSync(abs, abs + '.bak');
    fs.writeFileSync(abs, updated, 'utf8');
    return { ok: true, applied: hunks.length, backup: abs + '.bak' };
  }

  // Support search/replace block per blueprint
  const searchReplaceRe = /<<<<<<<\s*SEARCH\s*([\s\S]*?)=======\s*([\s\S]*?)>>>>>>>\s*REPLACE/;
  const sr = diff.match(searchReplaceRe);
  if (sr) {
    const oldBlock = sr[1].trim();
    const newBlock = sr[2].trim();
    const idx = original.indexOf(oldBlock);
    if (idx === -1) {
      // Try normalized match
      const normOrig = normalizeWhitespace(original);
      const normOld = normalizeWhitespace(oldBlock);
      const pos = normOrig.indexOf(normOld);
      if (pos === -1) return { ok: false, error: 'hunk_not_found' };
      // Best-effort: locate approximate slice by matching first and last lines
      const firstLine = oldBlock.split(/\r?\n/)[0].trim();
      const lastLine = oldBlock.split(/\r?\n/).slice(-1)[0].trim();
      const startIdx = original.indexOf(firstLine);
      const endIdx = original.lastIndexOf(lastLine);
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return { ok: false, error: 'fuzzy_match_failed' };
      const updated = original.slice(0, startIdx) + newBlock + original.slice(endIdx + lastLine.length);
      fs.copyFileSync(abs, abs + '.bak');
      fs.writeFileSync(abs, updated, 'utf8');
      return { ok: true, applied: 1, backup: abs + '.bak', fuzzy: true };
    }
    const updated = original.replace(oldBlock, newBlock);
    fs.copyFileSync(abs, abs + '.bak');
    fs.writeFileSync(abs, updated, 'utf8');
    return { ok: true, applied: 1, backup: abs + '.bak' };
  }

  return { ok: false, error: 'unsupported_diff_format' };
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

import type { DiffHunk, DiffLine } from './types.js';

/**
 * A line diff for the note-change confirmation card: what lines go, what
 * lines come. A longest-common-subsequence diff, enough for notes (at most
 * 48 KB). Past `MAX_LINES` on either side it shows the old text removed and
 * the new one added, which is still exactly what will happen.
 */

const MAX_LINES = 3000;

/** A text's lines, CRLF read as LF, without the empty string after a final newline. */
export const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

export function diffLines(before: string, after: string): DiffLine[] {
  return diffLineArrays(splitLines(before), splitLines(after));
}

/** The same diff over lines already split. */
export function diffLineArrays(a: readonly string[], b: readonly string[]): DiffLine[] {
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text): DiffLine => ({ op: '-', text })), ...b.map((text): DiffLine => ({ op: '+', text }))];
  }
  // Common prefix and suffix first: most edits touch a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j]: length of the LCS of midA[i..] and midB[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = midA[i] === midB[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      middle.push({ op: ' ', text: midA[i] as string });
      i += 1;
      j += 1;
    } else if (((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number)) {
      middle.push({ op: '-', text: midA[i] as string });
      i += 1;
    } else {
      middle.push({ op: '+', text: midB[j] as string });
      j += 1;
    }
  }
  while (i < n) middle.push({ op: '-', text: midA[i++] as string });
  while (j < m) middle.push({ op: '+', text: midB[j++] as string });
  return [
    ...a.slice(0, start).map((text): DiffLine => ({ op: ' ', text })),
    ...middle,
    ...a.slice(endA).map((text): DiffLine => ({ op: ' ', text })),
  ];
}

/** The changed lines with `context` unchanged lines around each run; the rest is counted as skipped. */
export function diffHunks(lines: readonly DiffLine[], context = 2): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.op === ' ') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const hunks: DiffHunk[] = [];
  let skipped = 0;
  let current: DiffHunk | undefined;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      skipped += 1;
      current = undefined;
      return;
    }
    if (current === undefined) {
      current = { skipped, lines: [] };
      hunks.push(current);
      skipped = 0;
    }
    current.lines.push(line);
  });
  return hunks;
}

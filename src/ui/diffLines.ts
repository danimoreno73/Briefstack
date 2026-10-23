import type { DiffHunkView } from './types.js';

/** One row of a diff as the page shows it: a gap of unchanged lines, or a line with its number. */
export type DiffRow = { kind: 'gap'; count: number } | { kind: 'line'; op: ' ' | '+' | '-'; text: string; number: number };

/**
 * The rows of a diff with line numbers. Hunks come in file order and each
 * one's `skipped` counts the unchanged lines since the previous one
 * (`src/chat/diff.ts`), so both files' line numbers follow from them: a
 * removed line shows its number in the old file, the others in the new one.
 * Pure.
 */
export function diffRows(hunks: readonly DiffHunkView[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let before = 0;
  let after = 0;
  for (const hunk of hunks) {
    if (hunk.skipped > 0) rows.push({ kind: 'gap', count: hunk.skipped });
    before += hunk.skipped;
    after += hunk.skipped;
    for (const line of hunk.lines) {
      if (line.op === '-') {
        before += 1;
        rows.push({ kind: 'line', op: '-', text: line.text, number: before });
      } else {
        after += 1;
        if (line.op === ' ') before += 1;
        rows.push({ kind: 'line', op: line.op, text: line.text, number: after });
      }
    }
  }
  return rows;
}

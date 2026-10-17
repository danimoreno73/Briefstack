import { OUTSIDE_TEXT } from '../panel/project.js';
import { REDACTED_LINE } from '../validate/secrets.js';
import { diffLineArrays, splitLines } from './diff.js';

/**
 * The chat reads notes redacted (`redactDeep`): a secret line becomes
 * `[redacted]`, a path under the home `~/…`, any other absolute path
 * `[outside allowed folders]`. A note change it proposes is written from
 * that view, so before it is shown or saved:
 *
 * - a proposed line that is exactly the redacted form of a line of the note
 *   gets the note's own line back (in place, or moved when only one
 *   original line has that redacted form), so an edit elsewhere never turns
 *   a real path or line into its placeholder;
 * - a placeholder left in any other new or changed line stands for text the
 *   model never saw, so the proposal is refused (`markers` lists those lines).
 */

export interface RestoredText {
  /** The proposed text with the note's own lines back. */
  text: string;
  /** 1-based lines of `text` that are new or changed and still hold a placeholder. */
  markers: number[];
}

const HOME_PATH_RE = /(?:^|[^\p{L}\p{N}_.~-])~[\\/]/u;

/** Whether a line holds one of the placeholders the chat's redacted view writes. */
export function hasRedactionMarker(line: string): boolean {
  return line.includes(REDACTED_LINE) || line.includes(OUTSIDE_TEXT) || HOME_PATH_RE.test(line);
}

export function restoreRedactedLines(original: string, proposed: string, redactLine: (line: string) => string): RestoredText {
  const before = splitLines(original);
  const shown = before.map(redactLine);
  const after = splitLines(proposed);

  // A redacted form that stands for one original text only, for lines the model moved.
  const unique = new Map<string, string | null>();
  shown.forEach((line, index) => {
    const own = before[index] as string;
    if (line === own) return;
    const known = unique.get(line);
    unique.set(line, known === undefined || known === own ? own : null);
  });
  const originals = new Set(before);

  const out: string[] = [];
  const markers: number[] = [];
  let i = 0;
  let j = 0;
  for (const line of diffLineArrays(shown, after)) {
    if (line.op === ' ') {
      out.push(before[i] as string);
      i += 1;
      j += 1;
    } else if (line.op === '-') {
      i += 1;
    } else {
      const text = after[j] as string;
      const restored = unique.get(text) ?? text;
      out.push(restored);
      if (!originals.has(restored) && hasRedactionMarker(restored)) markers.push(out.length);
      j += 1;
    }
  }
  if (out.length === 0) return { text: proposed, markers };
  return { text: `${out.join('\n')}${/\n$/.test(proposed) ? '\n' : ''}`, markers };
}

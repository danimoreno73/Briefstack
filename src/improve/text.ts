/**
 * Splitting an allowed file into its frontmatter and its body, byte for
 * byte, so the server can keep one and change the other (BRIEF-phase-5
 * §3.1, §3.4). Unlike `src/frontmatter`, nothing is parsed or rewritten.
 */

export interface SplitText {
  /** The opening `---` line through the closing `---` line and its line end; `''` when there is none. */
  head: string;
  body: string;
}

const HEAD_RE = /^(?:\u{FEFF})?---[ \t]*\r?\n(?:[^]*?\r?\n)?---[ \t]*(?:\r?\n|$)/u;

export function splitFrontmatter(text: string): SplitText {
  const match = HEAD_RE.exec(text);
  if (match === null) return { head: '', body: text };
  return { head: match[0], body: text.slice(match[0].length) };
}

/** Whether a file's content is text an improvement may hold: UTF-8 without NUL characters. */
export function isPlainText(buffer: Uint8Array): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

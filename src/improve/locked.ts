/**
 * Locked blocks (BRIEF-phase-5 §3.1): security-relevant instructions inside
 * allowed files, wrapped in markers on their own lines:
 *
 *   <!-- briefstack:locked web-mode -->
 *   ...
 *   <!-- /briefstack:locked web-mode -->
 *
 * A proposal that changes, moves or deletes a locked block, or adds a new
 * one, is rejected. "Moves" means the block now sits under another heading,
 * or the blocks are in another order. Blocks do not nest. Markers are plain
 * ASCII; a line that reads as one only after NFKC, without invisible
 * characters or with look-alike letters, is rejected.
 */

export interface LockedBlock {
  id: string;
  /** From the opening marker through the closing one, line ends as written. */
  text: string;
  /** The last markdown heading line before the block, trimmed; `''` when there is none. */
  heading: string;
}

export type LockedParse = { ok: true; blocks: LockedBlock[] } | { ok: false; error: string };

const OPEN_RE = /^\s*<!--\s*briefstack:locked\s+([a-z0-9][a-z0-9-]*)\s*-->\s*$/;
const CLOSE_RE = /^\s*<!--\s*\/briefstack:locked\s+([a-z0-9][a-z0-9-]*)\s*-->\s*$/;
/**
 * Letters of other scripts that look like the Latin ones (after NFKC and
 * lowercasing), so `briefstаck:lоcked` with Cyrillic letters is caught.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k',
  'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'һ': 'h', 'ԛ': 'q',
  // Greek
  'ο': 'o', 'α': 'a', 'κ': 'k', 'ι': 'i', 'ε': 'e', 'ϲ': 'c', 'ν': 'v', 'τ': 't', 'ρ': 'p',
  // Armenian
  'օ': 'o', 'ս': 'u',
  // Latin look-alikes NFKC keeps
  'ı': 'i', 'ɑ': 'a', 'ɩ': 'i', 'ʟ': 'l', 'ɡ': 'g',
};

/**
 * A line reduced to its Latin letters: NFKC (width forms, ligatures), no
 * invisible format characters, lowercase, look-alikes mapped, everything
 * that is not a-z dropped.
 */
function skeleton(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/[^\x20-\x7e]/gu, (char) => LOOK_ALIKES[char] ?? char)
    .replace(/[^a-z]/g, '');
}

/** Any line that reads as a marker once normalized, to catch a malformed or disguised one. */
const looksLikeMarker = (line: string): boolean => skeleton(line).includes('briefstacklocked');
const HEADING_RE = /^#{1,6}\s/;

export function parseLockedBlocks(text: string): LockedParse {
  const lines = text.split(/(?<=\n)/);
  const blocks: LockedBlock[] = [];
  const seen = new Set<string>();
  let heading = '';
  let open: { id: string; start: number; heading: string } | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r?\n$/, '');
    const opening = OPEN_RE.exec(line);
    const closing = CLOSE_RE.exec(line);
    if (opening !== null) {
      const id = opening[1] as string;
      if (open !== undefined) return { ok: false, error: `locked block "${id}" starts inside "${open.id}"` };
      if (seen.has(id)) return { ok: false, error: `locked block "${id}" appears twice` };
      seen.add(id);
      open = { id, start: index, heading };
      continue;
    }
    if (closing !== null) {
      const id = closing[1] as string;
      if (open === undefined || open.id !== id) return { ok: false, error: `the end of locked block "${id}" does not match an open block` };
      blocks.push({ id, text: lines.slice(open.start, index + 1).join(''), heading: open.heading });
      open = undefined;
      continue;
    }
    if (looksLikeMarker(line)) return { ok: false, error: `line ${index + 1} looks like a locked-block marker but is not one` };
    if (open === undefined && HEADING_RE.test(line)) heading = line.trim();
  }
  if (open !== undefined) return { ok: false, error: `locked block "${open.id}" is not closed` };
  return { ok: true, blocks };
}

/** Why `after` breaks the locked blocks of `before`; empty when it keeps them all exactly. */
export function lockedBlockProblems(before: string, after: string): string[] {
  const old = parseLockedBlocks(before);
  // A base file with broken markers is not ours to judge: nothing in it counts as locked.
  if (!old.ok) return [];
  const now = parseLockedBlocks(after);
  if (!now.ok) return [now.error];
  const problems: string[] = [];
  const nowById = new Map(now.blocks.map((block) => [block.id, block]));
  const oldIds = new Set(old.blocks.map((block) => block.id));
  for (const block of old.blocks) {
    const current = nowById.get(block.id);
    if (current === undefined) problems.push(`locked block "${block.id}" was deleted`);
    else if (current.text.replace(/\r\n/g, '\n') !== block.text.replace(/\r\n/g, '\n')) problems.push(`locked block "${block.id}" was changed`);
    else if (current.heading !== block.heading) problems.push(`locked block "${block.id}" was moved under another heading`);
  }
  for (const block of now.blocks) if (!oldIds.has(block.id)) problems.push(`locked block "${block.id}" was added`);
  if (problems.length === 0) {
    const order = (blocks: readonly LockedBlock[]) => blocks.map((block) => block.id).join(',');
    if (order(old.blocks) !== order(now.blocks)) problems.push('locked blocks are in another order');
  }
  return problems;
}

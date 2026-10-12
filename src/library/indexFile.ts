/**
 * Pure edits of `INDEX.md` and `log/INDEX.md`. An entry is one line:
 *
 *     - [[<link>]] — <one-line summary>
 *
 * Lines that do not look like entries (user text) are kept as they are.
 */

const ENTRY_RE = /^- \[\[([^[\]|#]+)(?:\|[^\]]*)?\]\](?:\s+—\s+(.*))?\s*$/;
const HEADING_RE = /^##\s+(.+?)\s*$/;
const MAX_SUMMARY = 120;

export interface IndexEntry {
  link: string;
  summary: string;
  /** The `##` heading the entry sits under, if any. */
  heading: string | undefined;
}

export function entryLine(link: string, summary: string): string {
  return `- [[${link}]] — ${summary}`;
}

/** One line, no wikilink brackets that would break the entry, at most 120 characters. */
export function cleanSummary(text: string): string {
  const line = text.replace(/\s+/g, ' ').replace(/\[\[|\]\]/g, '').trim();
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const joinLines = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

export function parseIndexEntries(text: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  let heading: string | undefined;
  for (const line of splitLines(text)) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch !== null) {
      heading = headingMatch[1];
      continue;
    }
    const match = ENTRY_RE.exec(line);
    if (match !== null) entries.push({ link: (match[1] ?? '').trim(), summary: match[2] ?? '', heading });
  }
  return entries;
}

function findEntry(lines: readonly string[], link: string): number {
  const wanted = link.toLowerCase();
  return lines.findIndex((line) => ENTRY_RE.exec(line)?.[1]?.trim().toLowerCase() === wanted);
}

/**
 * Sets the entry for `link` under `## <heading>`. An existing entry keeps its
 * place (its summary changes only when `summary` is given); a new one goes
 * after the last entry of the section, creating the heading if needed.
 */
export function upsertIndexEntry(
  text: string,
  heading: string,
  link: string,
  summary: string | undefined,
): { text: string; changed: boolean } {
  const lines = splitLines(text);
  const existing = findEntry(lines, link);
  if (existing !== -1) {
    if (summary === undefined) return { text, changed: false };
    const line = entryLine(link, summary);
    if (lines[existing] === line) return { text, changed: false };
    lines[existing] = line;
    return { text: joinLines(lines), changed: true };
  }

  const line = entryLine(link, summary ?? '');
  const start = lines.findIndex((item) => HEADING_RE.exec(item)?.[1] === heading);
  if (start === -1) {
    while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
    lines.push('', `## ${heading}`, '', line);
    return { text: joinLines(lines), changed: true };
  }
  let end = lines.findIndex((item, index) => index > start && HEADING_RE.test(item));
  if (end === -1) end = lines.length;
  let lastEntry = -1;
  for (let index = start + 1; index < end; index++) {
    if (ENTRY_RE.test(lines[index] ?? '')) lastEntry = index;
  }
  if (lastEntry !== -1) {
    lines.splice(lastEntry + 1, 0, line);
  } else {
    // Right under the heading, with one blank line before and, unless it
    // ends the file, one after.
    let after = start + 1;
    while (after < end && lines[after]?.trim() === '') after++;
    const insert = after < lines.length ? ['', line, ''] : ['', line];
    lines.splice(start + 1, after - (start + 1), ...insert);
  }
  return { text: joinLines(lines), changed: true };
}

/**
 * Adds `link` as the first entry (newest first). An existing entry is moved
 * to the top only when it is new; otherwise its summary is updated in place.
 */
export function prependIndexEntry(
  text: string,
  link: string,
  summary: string | undefined,
): { text: string; changed: boolean } {
  const lines = splitLines(text);
  const existing = findEntry(lines, link);
  if (existing !== -1) {
    if (summary === undefined) return { text, changed: false };
    const line = entryLine(link, summary);
    if (lines[existing] === line) return { text, changed: false };
    lines[existing] = line;
    return { text: joinLines(lines), changed: true };
  }
  const line = entryLine(link, summary ?? '');
  const first = lines.findIndex((item) => ENTRY_RE.test(item));
  if (first !== -1) {
    lines.splice(first, 0, line);
  } else {
    while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
    lines.push('', line);
  }
  return { text: joinLines(lines), changed: true };
}

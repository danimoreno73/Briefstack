import path from 'node:path';

/**
 * Markdown link extraction and resolution. Pure: the project's files are
 * passed in as relative paths with `/`.
 */

export interface MarkdownLink {
  kind: 'wikilink' | 'relative';
  target: string;
  /** 1-based. */
  line: number;
}

/**
 * Lines with fenced code blocks and inline code spans blanked out, so links
 * shown as code are not checked. Line count and numbering are preserved.
 */
export function maskCode(lines: readonly string[]): string[] {
  const result: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== undefined) {
      const closing = marker?.[1];
      if (
        closing !== undefined &&
        closing[0] === fence.char &&
        closing.length >= fence.length &&
        line.trim() === closing
      ) {
        fence = undefined;
      }
      result.push('');
      continue;
    }
    const opening = marker?.[1];
    if (opening !== undefined) {
      fence = { char: opening[0] ?? '`', length: opening.length };
      result.push('');
      continue;
    }
    result.push(maskInlineCode(line));
  }
  return result;
}

function maskInlineCode(line: string): string {
  let out = '';
  let index = 0;
  while (index < line.length) {
    const run = /^`+/.exec(line.slice(index));
    if (run === null) {
      out += line[index];
      index += 1;
      continue;
    }
    const ticks = run[0];
    const close = findClosingRun(line, index + ticks.length, ticks.length);
    if (close === -1) {
      out += ticks;
      index += ticks.length;
      continue;
    }
    const end = close + ticks.length;
    out += ' '.repeat(end - index);
    index = end;
  }
  return out;
}

function findClosingRun(line: string, from: number, length: number): number {
  const re = /`+/g;
  re.lastIndex = from;
  for (let match = re.exec(line); match !== null; match = re.exec(line)) {
    if (match[0].length === length) return match.index;
  }
  return -1;
}

const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g;
// `[text](target "title")`, also images and `<target with spaces>`.
const INLINE_LINK_RE =
  /\[(?:[^[\]]|\[[^[\]]*\])*\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const REFERENCE_DEF_RE = /^ {0,3}\[[^\]]+\]:\s*(<[^<>]*>|\S+)/;

/** Wikilinks and relative markdown links, outside code. */
export function extractLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  maskCode(text.split(/\r?\n/)).forEach((line, index) => {
    const lineNumber = index + 1;
    for (const match of line.matchAll(WIKILINK_RE)) {
      links.push({ kind: 'wikilink', target: match[1] ?? '', line: lineNumber });
    }
    const withoutWikilinks = line.replace(WIKILINK_RE, (match) => ' '.repeat(match.length));
    const targets = [...withoutWikilinks.matchAll(INLINE_LINK_RE)].map((match) => match[1] ?? '');
    const reference = REFERENCE_DEF_RE.exec(withoutWikilinks);
    if (reference !== null) targets.push(reference[1] ?? '');
    for (const target of targets) {
      const unwrapped = target.startsWith('<') ? target.slice(1, -1) : target;
      if (isLocalLink(unwrapped)) links.push({ kind: 'relative', target: unwrapped, line: lineNumber });
    }
  });
  return links;
}

/** False for URLs with a scheme (`https:`, `mailto:`...) and pure `#anchor` links. */
function isLocalLink(target: string): boolean {
  if (target === '' || target.startsWith('#')) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]+:/.test(target);
}

/** The set of project paths a link may point to. */
export interface ProjectPaths {
  /** Every file, relative with `/`. */
  files: readonly string[];
  /** Every folder, relative with `/`. */
  directories: readonly string[];
}

/**
 * Whether a relative link from `fromFile` resolves to a file or folder of
 * the project. Case-sensitive, so a link that only works on Windows or macOS
 * is reported. A leading `/` is relative to the project root.
 */
export function resolvesRelative(target: string, fromFile: string, paths: ProjectPaths): boolean {
  let clean = target.replace(/[?#].*$/, '');
  if (clean === '') return true;
  try {
    clean = decodeURI(clean);
  } catch {
    // Keep it undecoded.
  }
  const base = clean.startsWith('/') ? '' : path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(base, clean.replace(/^\/+/, ''))).replace(/\/+$/, '');
  if (joined === '.' || joined === '') return true;
  if (joined === '..' || joined.startsWith('../')) return false;
  return paths.files.includes(joined) || paths.directories.includes(joined);
}

/**
 * Whether `[[target]]` resolves Obsidian-style: by note name, against any
 * `.md` file in the project (case-insensitive), or against any file when it
 * names one with its extension. `|alias` and `#heading` are ignored; a link
 * to a heading in the same note (`[[#heading]]`) always resolves.
 */
export function resolvesWikilink(target: string, paths: ProjectPaths): boolean {
  const beforeAlias = target.split(/\\?\|/)[0] ?? '';
  const name = (beforeAlias.split(/[#^]/)[0] ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
  if (name === '') return true;
  const matches = (candidate: string, wanted: string) =>
    candidate === wanted || candidate.endsWith(`/${wanted}`);

  const files = paths.files.map((file) => file.toLowerCase());
  const noteName = name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
  const notes = files.filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length));
  return notes.some((note) => matches(note, noteName)) || files.some((file) => matches(file, name));
}

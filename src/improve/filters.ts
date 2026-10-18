import { diffLines } from '../chat/diff.js';
import { findSecrets } from '../validate/secrets.js';

/**
 * The checks on every proposed text (BRIEF-phase-5 §3.2 "Generic only", §4):
 * the repo is meant to be public, so an added line may not hold a secret, a
 * path of this machine or of any real user, or text copied from the user's
 * library profile. Only lines the proposal adds are checked: what the base
 * already holds was reviewed when it was committed.
 */

export type FilterKind = 'secret' | 'personalPath' | 'profileText';

export interface FilterProblem {
  kind: FilterKind;
  /** 1-based line in the proposed text. */
  line: number;
  /** Never the matched text itself: what kind of thing was found. */
  detail: string;
}

export interface PersonalContext {
  /** The user's home folder. */
  homedir: string;
  /** The login name, when known. */
  username?: string | undefined;
  /** briefstack's own folders on this machine: home, library, projects, sessions. */
  folders: readonly string[];
  /** The texts of the library's `profile` notes. */
  profileTexts: readonly string[];
}

/** Names a path under a home folder may use in a generic example. */
const PLACEHOLDER_NAMES = new Set(['you', 'user', 'username', 'me', 'name', 'your-name', 'yourname', 'example', '<user>', '<you>', '<name>', '...', '…']);
/** `C:\Users\<name>`, `/Users/<name>`, `/home/<name>` with either slash. */
const HOME_PATH_RE = /(?:\b[A-Za-z]:[\\/]+Users|(?<![\w.])\/Users|(?<![\w.])\/home)[\\/]+([^\\/\s"'`<>|)\]]+)/gi;
/** Words too common to count as a user's name on their own. */
const COMMON_NAMES = new Set(['user', 'admin', 'root', 'home', 'test', 'you', 'me', 'dev', 'owner']);
const MIN_PROFILE_LINE = 24;
const SHINGLE_WORDS = 8;

/** Lowercase, `/` for `\`, no trailing slash: how paths are compared in text. */
const foldPath = (value: string): string => value.replace(/\\+/g, '/').replace(/\/+$/, '').toLowerCase();

/** Letters and digits only, single spaces: how profile text is compared. */
const foldWords = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function shingles(words: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) found.add(words.slice(i, i + SHINGLE_WORDS).join(' '));
  return found;
}

/** The lines `after` adds to `before`, with their 1-based line numbers in `after`. */
export function addedLines(before: string, after: string): { line: number; text: string }[] {
  const added: { line: number; text: string }[] = [];
  let line = 0;
  for (const entry of diffLines(before, after)) {
    if (entry.op === '-') continue;
    line += 1;
    if (entry.op === '+') added.push({ line, text: entry.text });
  }
  return added;
}

export interface PreparedContext {
  homes: string[];
  folders: string[];
  username: string | undefined;
  profileLines: string[];
  profileShingles: Set<string>;
}

/** Folds the context once for many files. */
export function prepareContext(context: PersonalContext): PreparedContext {
  const profileLines: string[] = [];
  const profileShingles = new Set<string>();
  for (const text of context.profileTexts) {
    for (const raw of text.split(/\r?\n/)) {
      const folded = foldWords(raw.replace(/^[#>*\-\s\d.]+/, ''));
      if (folded.length >= MIN_PROFILE_LINE) profileLines.push(folded);
    }
    for (const shingle of shingles(foldWords(text).split(' ').filter((word) => word !== ''))) profileShingles.add(shingle);
  }
  const username = context.username?.trim().toLowerCase();
  return {
    homes: context.homedir.length > 3 ? [foldPath(context.homedir)] : [],
    folders: context.folders.map(foldPath).filter((folder) => folder.length > 3),
    username: username !== undefined && username.length >= 3 && !COMMON_NAMES.has(username) ? username : undefined,
    profileLines,
    profileShingles,
  };
}

function personalPath(text: string, context: PreparedContext): string | undefined {
  const folded = foldPath(text);
  if (context.homes.some((home) => folded.includes(home))) return "this machine's home folder";
  if (context.folders.some((folder) => folded.includes(folder))) return "one of briefstack's folders on this machine";
  for (const match of text.matchAll(HOME_PATH_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!PLACEHOLDER_NAMES.has(name)) return 'a path under a real user folder (use a placeholder such as "you")';
  }
  if (context.username !== undefined) {
    const escaped = context.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[\\\\/])${escaped}(?:[\\\\/]|$)`, 'i').test(text)) return "this machine's user name in a path";
  }
  return undefined;
}

function profileCopy(text: string, context: PreparedContext): boolean {
  const folded = foldWords(text);
  if (folded.length >= MIN_PROFILE_LINE && context.profileLines.some((line) => line.includes(folded) || folded.includes(line))) return true;
  const words = folded.split(' ').filter((word) => word !== '');
  for (const shingle of shingles(words)) if (context.profileShingles.has(shingle)) return true;
  return false;
}

/** Every problem in the lines `after` adds to `before`. */
export function checkProposedText(before: string, after: string, context: PreparedContext): FilterProblem[] {
  const problems: FilterProblem[] = [];
  for (const { line, text } of addedLines(before, after)) {
    if (findSecrets(text).length > 0) problems.push({ kind: 'secret', line, detail: 'something that looks like a secret' });
    const where = personalPath(text, context);
    if (where !== undefined) problems.push({ kind: 'personalPath', line, detail: where });
    if (profileCopy(text, context)) problems.push({ kind: 'profileText', line, detail: "text from the user's library profile" });
  }
  return problems;
}

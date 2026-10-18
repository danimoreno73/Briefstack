import { diffLines } from '../chat/diff.js';
import { findSecrets } from '../validate/secrets.js';

/**
 * The checks on every proposed text (BRIEF-phase-5 §3.2 "Generic only", §4):
 * the repo is meant to be public, so an added line may not hold a secret, a
 * path of this machine or of any real user, a path written from a home
 * folder (`~/`), an e-mail address, the git user's name, the name of one of
 * the user's projects, or text copied from the user's library profile or
 * lessons. Only lines the proposal adds are checked: what the base already
 * holds was reviewed when it was committed.
 */

export type FilterKind = 'secret' | 'personalPath' | 'personalData' | 'profileText' | 'lessonText';

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
  /** `git config user.name` and `user.email` of the repo, when set. */
  gitName?: string | undefined;
  gitEmail?: string | undefined;
  /** The names of the user's projects: the library's project notes and the folders in the projects folder. */
  projectNames?: readonly string[];
  /** The text of the library's lessons. */
  lessonTexts?: readonly string[];
}

/** Names a path under a home folder may use in a generic example. */
const PLACEHOLDER_NAMES = new Set(['you', 'user', 'username', 'me', 'name', 'your-name', 'yourname', 'example', '<user>', '<you>', '<name>', '...', '…']);
/** `C:\Users\<name>`, `/Users/<name>`, `/home/<name>` with either slash. */
const HOME_PATH_RE = /(?:\b[A-Za-z]:[\\/]+Users|(?<![\w.])\/Users|(?<![\w.])\/home)[\\/]+([^\\/\s"'`<>|)\]]+)/gi;
/** A path written from a home folder: `~/…` or `~\…`, not `approx~ish`. */
const TILDE_PATH_RE = /(?<![\w~])~[\\/]/;
/** An e-mail address. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
/** Domains reserved for examples (RFC 2606, RFC 6761): an address there is a placeholder. */
const PLACEHOLDER_DOMAIN_RE = /(?:^|\.)(?:example(?:\.(?:com|org|net))?|invalid|test|localhost)$/i;
/** Words too common to count as a user's name on their own. */
const COMMON_NAMES = new Set(['user', 'admin', 'root', 'home', 'test', 'you', 'me', 'dev', 'owner']);
const MIN_PROFILE_LINE = 24;
const SHINGLE_WORDS = 8;
/** Shorter project names are too common to tell from ordinary words. */
const MIN_PROJECT_NAME = 4;

/** Lowercase, `/` for `\`, no trailing slash: how paths are compared in text. */
const foldPath = (value: string): string => value.replace(/\\+/g, '/').replace(/\/+$/, '').toLowerCase();

/** Letters and digits only, single spaces: how profile text, names and project names are compared. */
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

const wordsOf = (text: string): string[] => foldWords(text).split(' ').filter((word) => word !== '');

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
  lessonShingles: Set<string>;
  /** Folded names (git user name, project names) matched as whole words. */
  names: string[];
  /** Lowercased e-mail addresses that are always personal, even at a placeholder domain. */
  emails: string[];
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
    for (const shingle of shingles(wordsOf(text))) profileShingles.add(shingle);
  }
  const lessonShingles = new Set<string>();
  for (const text of context.lessonTexts ?? []) for (const shingle of shingles(wordsOf(text))) lessonShingles.add(shingle);
  const username = context.username?.trim().toLowerCase();
  const names = new Set<string>();
  const gitName = foldWords(context.gitName ?? '');
  if (gitName.length >= 3 && !COMMON_NAMES.has(gitName)) names.add(gitName);
  for (const project of context.projectNames ?? []) {
    const folded = foldWords(project);
    if (folded.replace(/ /g, '').length >= MIN_PROJECT_NAME) names.add(folded);
  }
  const gitEmail = context.gitEmail?.trim().toLowerCase();
  return {
    homes: context.homedir.length > 3 ? [foldPath(context.homedir)] : [],
    folders: context.folders.map(foldPath).filter((folder) => folder.length > 3),
    username: username !== undefined && username.length >= 3 && !COMMON_NAMES.has(username) ? username : undefined,
    profileLines,
    profileShingles,
    lessonShingles,
    names: [...names],
    emails: gitEmail !== undefined && gitEmail.includes('@') ? [gitEmail] : [],
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
  if (TILDE_PATH_RE.test(text)) return 'a path written from a home folder with ~ (use a placeholder such as <home>)';
  return undefined;
}

function personalData(text: string, context: PreparedContext): string | undefined {
  const lower = text.toLowerCase();
  if (context.emails.some((email) => lower.includes(email))) return "the git user's e-mail address";
  for (const match of text.matchAll(EMAIL_RE)) {
    if (!PLACEHOLDER_DOMAIN_RE.test(match[1] ?? '')) return 'an e-mail address (use one at example.com)';
  }
  const folded = ` ${foldWords(text)} `;
  if (context.names.some((name) => folded.includes(` ${name} `))) return "a name of the user's (the git user name or one of their projects)";
  return undefined;
}

function hasShingle(text: string, from: ReadonlySet<string>): boolean {
  if (from.size === 0) return false;
  for (const shingle of shingles(wordsOf(text))) if (from.has(shingle)) return true;
  return false;
}

function profileCopy(text: string, context: PreparedContext): boolean {
  const folded = foldWords(text);
  if (folded.length >= MIN_PROFILE_LINE && context.profileLines.some((line) => line.includes(folded) || folded.includes(line))) return true;
  return hasShingle(text, context.profileShingles);
}

/** Every problem in one text, as if each of its lines were added. */
export function checkText(text: string, context: PreparedContext): FilterProblem[] {
  return checkProposedText('', text, context);
}

/** Every problem in the lines `after` adds to `before`. */
export function checkProposedText(before: string, after: string, context: PreparedContext): FilterProblem[] {
  const problems: FilterProblem[] = [];
  for (const { line, text } of addedLines(before, after)) {
    if (findSecrets(text).length > 0) problems.push({ kind: 'secret', line, detail: 'something that looks like a secret' });
    const where = personalPath(text, context);
    if (where !== undefined) problems.push({ kind: 'personalPath', line, detail: where });
    const who = personalData(text, context);
    if (who !== undefined) problems.push({ kind: 'personalData', line, detail: who });
    if (profileCopy(text, context)) problems.push({ kind: 'profileText', line, detail: "text from the user's library profile" });
    if (hasShingle(text, context.lessonShingles)) problems.push({ kind: 'lessonText', line, detail: "text copied from the user's library lessons" });
  }
  return problems;
}

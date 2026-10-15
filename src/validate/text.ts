import type { PathEnv } from '../config/paths.js';
import type { AbsolutePathKind } from './findings.js';

export { REDACTED_LINE, findSecrets, looksRandom, redactSecretLines } from './secrets.js';

/**
 * Line-level detectors for secrets and machine paths. Pure functions, so
 * tests can run them with `path.win32` and `path.posix` environments.
 */

export interface AbsolutePathMatch {
  kind: AbsolutePathKind;
  match: string;
  index: number;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// URLs are not machine paths; `file://` URLs are.
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]*/g;
const PATH_TAIL = '[^\\s"\'`<>|*?()\\[\\]]*';
const DRIVE_RE = new RegExp(`(?<![\\p{L}\\p{N}_])[A-Za-z]:[\\\\/]${PATH_TAIL}`, 'gu');
const USERS_DIR_RE = /(?<![\p{L}\p{N}_.~-])\/Users\/[\p{L}\p{N}._-]+/gu;
const HOME_FOLDER_RE = /(?<![\p{L}\p{N}_.~-])\/home\/[\p{L}\p{N}._-]+/gu;

/** The home directory as it may appear in text: native, `/`, and JSON-escaped. */
function homeDirRegExp(pathEnv: Pick<PathEnv, 'homedir' | 'pathApi' | 'caseInsensitive'>): RegExp | undefined {
  const home = pathEnv.homedir.replace(/[\\/]+$/, '');
  if (home.length < 2 || pathEnv.pathApi.parse(home).root === home) return undefined;
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
  const alternatives = [...variants].map(escapeRegExp).join('|');
  const insensitive = pathEnv.caseInsensitive || pathEnv.pathApi.sep === '\\';
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_-])${PATH_TAIL}`,
    insensitive ? 'giu' : 'gu',
  );
}

/**
 * Absolute paths from a real machine on one line: the home directory,
 * drive-letter paths, `/Users/<name>` and `/home/<name>`. Paths starting
 * with `~`, deny patterns such as `//**` and URLs are not reported.
 * Overlapping matches are reported once, preferring the home directory.
 */
export function findAbsolutePaths(
  line: string,
  pathEnv: Pick<PathEnv, 'homedir' | 'pathApi' | 'caseInsensitive'>,
): AbsolutePathMatch[] {
  const urls: [number, number][] = [];
  for (const url of line.matchAll(URL_RE)) {
    if (!url[0].toLowerCase().startsWith('file:')) urls.push([url.index, url.index + url[0].length]);
  }
  const inUrl = (index: number) => urls.some(([start, end]) => index >= start && index < end);

  const candidates: AbsolutePathMatch[] = [];
  const collect = (re: RegExp | undefined, kind: AbsolutePathKind) => {
    if (re === undefined) return;
    for (const match of line.matchAll(re)) {
      if (!inUrl(match.index)) candidates.push({ kind, match: match[0], index: match.index });
    }
  };
  collect(homeDirRegExp(pathEnv), 'homeDir');
  collect(DRIVE_RE, 'windowsDrive');
  collect(USERS_DIR_RE, 'usersDir');
  collect(HOME_FOLDER_RE, 'homeFolder');

  const kept: AbsolutePathMatch[] = [];
  for (const candidate of candidates) {
    const end = candidate.index + candidate.match.length;
    const overlaps = kept.some(
      (other) => candidate.index < other.index + other.match.length && other.index < end,
    );
    if (!overlaps) kept.push(candidate);
  }
  return kept.sort((a, b) => a.index - b.index);
}

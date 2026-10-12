import type { PathEnv } from '../config/paths.js';
import type { AbsolutePathKind, SecretKind } from './findings.js';

/**
 * Line-level detectors for secrets and machine paths. Pure functions, so
 * tests can run them with `path.win32` and `path.posix` environments.
 */

interface SecretPattern {
  kind: SecretKind;
  re: RegExp;
  /** Extra check on the captured value (group 1, or the whole match). */
  accept?: (value: string) => boolean;
}

const PLACEHOLDER =
  /x{4,}|\*{3,}|\.{3}|<|>|\$\{|\{\{|\$\(|your|example|placeholder|changeme|change_me|dummy|sample|redacted|replace|insert|fake|todo/i;

/** A credential-like value: long, mixed letters and digits, varied, not a placeholder. */
export function looksRandom(value: string): boolean {
  if (value.length < 20 || /\s/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  return new Set(value).size >= 10;
}

const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|secret|token)';

/** High-signal patterns only; generic assignments must also look random. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'privateKey', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  {
    kind: 'aws',
    re: /(?<![A-Z0-9])((?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Z0-9])/,
    accept: (value) => !value.endsWith('EXAMPLE'),
  },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { kind: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { kind: 'stripe', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}/ },
  {
    // `api_key = "..."`, `"apiKey": "..."`, `password: '...'`
    kind: 'assignment',
    re: new RegExp(`${SECRET_NAME}["']?\\s*[:=]\\s*["']([^"'\\s]+)["']`, 'i'),
    accept: looksRandom,
  },
  {
    // `.env` style: `OPENAI_API_KEY=...` without quotes.
    kind: 'assignment',
    re: /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*([^\s"'#]+)/,
    accept: looksRandom,
  },
];

/** Kinds of secret-looking strings on one line, each reported once. */
export function findSecrets(line: string): SecretKind[] {
  const kinds: SecretKind[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (kinds.includes(pattern.kind)) continue;
    const match = pattern.re.exec(line);
    if (match === null) continue;
    const value = match[1] ?? match[0];
    if (pattern.accept === undefined || pattern.accept(value)) kinds.push(pattern.kind);
  }
  return kinds;
}

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

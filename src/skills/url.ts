import { BriefstackError, type SkillUrlProblem } from '../errors.js';

/**
 * A GitHub link to a skill folder (BRIEF-phase-6 §3.1). Accepted forms:
 *
 *   https://github.com/<owner>/<repo>                       the repo root, default branch
 *   https://github.com/<owner>/<repo>/tree/<ref>/<path>     a folder at a branch, tag or commit
 *   https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md
 *
 * A ref may hold slashes (`feature/x`), so `tree/feature/x/skills/y` is
 * ambiguous: `candidates` lists every split, shortest ref first, for the
 * fetcher to try. Query strings and fragments are ignored.
 */

export type { SkillUrlProblem };

export interface SkillUrl {
  owner: string;
  repo: string;
  /** The link as given, trimmed. */
  url: string;
  /** Path segments after `tree/` or `blob/` (ref and folder together); empty for the repo root. */
  rest: string[];
  /** `root`: no ref given, the default branch (`HEAD`). */
  kind: 'root' | 'tree' | 'blob';
}

/** One way to read `rest`: a ref and the folder under it. */
export interface RefCandidate {
  ref: string;
  /** Folder of the skill inside the repo, with `/`; empty for the root. */
  path: string;
}

/** At most this many splits of a slashed ref are tried. */
export const MAX_REF_CANDIDATES = 5;
export const MAX_URL_LENGTH = 2000;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT = /[\u0000-\u001f\u007f\\]/;

const invalid = (url: string, reason: SkillUrlProblem): BriefstackError<'skills.invalidUrl'> =>
  new BriefstackError('skills.invalidUrl', { url: url.slice(0, 200), reason });

export function parseSkillUrl(input: string): SkillUrl {
  const url = input.trim();
  if (url.length > MAX_URL_LENGTH) throw invalid(url, 'shape');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid(url, 'shape');
  }
  if (parsed.protocol !== 'https:') throw invalid(url, 'notHttps');
  const host = parsed.hostname.toLowerCase();
  if ((host !== 'github.com' && host !== 'www.github.com') || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') {
    throw invalid(url, 'notGithub');
  }
  let segments: string[];
  try {
    segments = parsed.pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    throw invalid(url, 'shape');
  }
  if (segments.some((segment) => BAD_SEGMENT.test(segment) || segment === '.' || segment === '..' || segment.includes('/'))) {
    throw invalid(url, 'shape');
  }
  const [owner, rawRepo, kind, ...rest] = segments;
  if (owner === undefined || rawRepo === undefined) throw invalid(url, 'shape');
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -'.git'.length) : rawRepo;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') throw invalid(url, 'shape');
  if (kind === undefined) return { owner, repo, url, rest: [], kind: 'root' };
  if (kind !== 'tree' && kind !== 'blob') throw invalid(url, 'shape');
  if (rest.length === 0) throw invalid(url, 'shape');
  if (kind === 'blob') {
    if (rest.length < 2 || rest[rest.length - 1] !== 'SKILL.md') throw invalid(url, 'notSkillFile');
    return { owner, repo, url, rest: rest.slice(0, -1), kind };
  }
  return { owner, repo, url, rest, kind };
}

/** Every split of `rest` into a ref and a folder, shortest ref first, at most `MAX_REF_CANDIDATES`. */
export function refCandidates(parsed: SkillUrl): RefCandidate[] {
  if (parsed.kind === 'root') return [{ ref: 'HEAD', path: '' }];
  const out: RefCandidate[] = [];
  for (let cut = 1; cut <= parsed.rest.length && out.length < MAX_REF_CANDIDATES; cut += 1) {
    out.push({ ref: parsed.rest.slice(0, cut).join('/'), path: parsed.rest.slice(cut).join('/') });
  }
  return out;
}

/** The link of a folder at a commit, as stored in the metadata note. */
export function treeUrl(owner: string, repo: string, commit: string, folder: string): string {
  const tail = folder === '' ? '' : `/${folder.split('/').map(encodeURIComponent).join('/')}`;
  return `https://github.com/${owner}/${repo}/tree/${commit}${tail}`;
}

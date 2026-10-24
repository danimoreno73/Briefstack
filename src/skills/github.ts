import { createHash } from 'node:crypto';
import { BriefstackError, type SkillEntryProblem } from '../errors.js';
import { isSafeRelativePath } from '../spec/schema.js';
import { parseSkillUrl, refCandidates, type RefCandidate, type SkillUrl } from './url.js';

/**
 * Fetches one skill folder of a public GitHub repo, pinned to a commit
 * (BRIEF-phase-6 §3.1; docs/decisions.md, phase 6 H0 point 1). Without a
 * token, from two hosts only: the REST API (pin the ref, list the trees)
 * and `raw.githubusercontent.com` (the files, at the pinned commit). Every
 * file is checked against its git blob hash from the tree. Nothing is
 * written anywhere: the caller gets the bytes.
 */

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';

export interface FetchLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Per request. */
  requestTimeoutMs: number;
  /** For the whole fetch. */
  totalTimeoutMs: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

/** JSON answers of the API are never larger than this (a tree of 200 files is far smaller). */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** A license file at the repo root is read only up to this size. */
const MAX_LICENSE_BYTES = 256 * 1024;

export interface FetchedFile {
  /** Relative to the skill folder, with `/`. */
  path: string;
  bytes: Buffer;
  /** Whether git marks it executable (`100755`). */
  executable: boolean;
}

export interface FetchedSkill {
  owner: string;
  repo: string;
  /** The ref that was asked for (`HEAD` for the default branch). */
  ref: string;
  commit: string;
  /** The skill folder inside the repo, with `/`; empty for the root. */
  path: string;
  /** The link as the user gave it. */
  url: string;
  files: FetchedFile[];
  /** A license file at the repo root, when the skill folder is not the root. */
  rootLicense?: { path: string; bytes: Buffer };
}

export interface FetchOptions {
  apiBase?: string;
  rawBase?: string;
  limits?: Partial<FetchLimits>;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface TreeAnswer {
  tree: TreeEntry[];
  truncated: boolean;
}

/** Names that change how the library's git stores files; a skill holding one is refused. */
const GIT_CONTROL = new Set(['.gitattributes', '.gitmodules']);
const LFS_POINTER = Buffer.from('version https://git-lfs.github.com/spec/v1');
const LICENSE_NAME = /^(?:licen[cs]e|copying|unlicense)(?:[-._][a-z0-9.-]*)?$/i;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_PATH_LENGTH = 200;
const MAX_DEPTH = 10;

/** The git blob hash of `bytes`: what a tree entry's `sha` is. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');

class Fetcher {
  private readonly deadline: number;
  private readonly fetchFn: typeof fetch;
  readonly limits: FetchLimits;
  readonly api: string;
  readonly raw: string;

  constructor(options: FetchOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.deadline = Date.now() + this.limits.totalTimeoutMs;
    this.fetchFn = options.fetch ?? fetch;
    this.api = (options.apiBase ?? GITHUB_API).replace(/\/+$/, '');
    this.raw = (options.rawBase ?? GITHUB_RAW).replace(/\/+$/, '');
  }

  /** One GET with the per-request and overall timeouts; no redirect is followed. */
  async get(url: string, accept: string, maxBytes: number): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new BriefstackError('skills.network', { detail: 'the fetch took too long' });
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept, 'user-agent': 'briefstack', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(Math.min(left, this.limits.requestTimeoutMs)),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new BriefstackError('skills.network', { detail: timedOut ? 'a request timed out' : 'GitHub could not be reached' });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new BriefstackError('skills.network', { detail: `GitHub answered a redirect (${response.status}), which is not followed` });
    }
    const body = await readCapped(response, maxBytes);
    return { status: response.status, headers: response.headers, body };
  }

  /** Throws the rate-limit error when the answer is one. */
  checkRateLimit(status: number, headers: Headers): void {
    if (status !== 403 && status !== 429) return;
    const remaining = headers.get('x-ratelimit-remaining');
    const retryAfter = headers.get('retry-after');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining === '0' || retryAfter !== null || status === 429) {
      let at: string | null = null;
      if (remaining === '0' && reset !== null && /^\d+$/.test(reset)) at = new Date(Number(reset) * 1000).toISOString();
      else if (retryAfter !== null && /^\d+$/.test(retryAfter)) at = new Date(Date.now() + Number(retryAfter) * 1000).toISOString();
      throw new BriefstackError('skills.rateLimited', { reset: at });
    }
  }

  async json(path: string): Promise<{ status: number; data: unknown }> {
    const { status, headers, body } = await this.get(`${this.api}${path}`, 'application/vnd.github+json', MAX_JSON_BYTES);
    this.checkRateLimit(status, headers);
    if (status !== 200) return { status, data: undefined };
    try {
      return { status, data: JSON.parse(body.toString('utf8')) as unknown };
    } catch {
      throw new BriefstackError('skills.network', { detail: 'GitHub answered something that is not JSON' });
    }
  }

  /** The commit SHA of `ref`, or `undefined` when GitHub does not know the ref. */
  async pin(owner: string, repo: string, ref: string): Promise<string | undefined> {
    const { status, headers, body } = await this.get(
      `${this.api}/repos/${owner}/${repo}/commits/${encodePath(ref)}`,
      'application/vnd.github.sha',
      1024,
    );
    this.checkRateLimit(status, headers);
    if (status === 404) throw new BriefstackError('skills.repoNotFound', { owner, repo });
    if (status === 422 || status === 409) return undefined;
    if (status !== 200) throw new BriefstackError('skills.network', { detail: `GitHub answered ${status} for the ref` });
    const sha = body.toString('utf8').trim().toLowerCase();
    if (!SHA_RE.test(sha)) throw new BriefstackError('skills.network', { detail: 'GitHub answered a ref that is not a commit SHA' });
    return sha;
  }

  async tree(owner: string, repo: string, sha: string, recursive: boolean): Promise<TreeAnswer | undefined> {
    const { status, data } = await this.json(`/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
    if (status === 404) return undefined;
    if (status !== 200) throw new BriefstackError('skills.network', { detail: `GitHub answered ${status} for a folder listing` });
    return parseTree(data);
  }

  async rawFile(owner: string, repo: string, commit: string, path: string, maxBytes: number): Promise<Buffer> {
    const { status, body } = await this.get(`${this.raw}/${owner}/${repo}/${commit}/${encodePath(path)}`, '*/*', maxBytes);
    if (status !== 200) throw new BriefstackError('skills.network', { detail: `GitHub answered ${status} for ${path}` });
    return body;
  }
}

/** The whole body, refused past `maxBytes` without reading the rest. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BriefstackError('skills.network', { detail: 'GitHub answered more data than expected' });
  }
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BriefstackError('skills.network', { detail: 'GitHub answered more data than expected' });
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof BriefstackError) throw error;
    throw new BriefstackError('skills.network', { detail: 'the download was cut' });
  }
  return Buffer.concat(chunks);
}

function parseTree(data: unknown): TreeAnswer {
  const fail = (): never => {
    throw new BriefstackError('skills.network', { detail: 'GitHub answered a folder listing in an unknown shape' });
  };
  if (typeof data !== 'object' || data === null) return fail();
  const record = data as { tree?: unknown; truncated?: unknown };
  if (!Array.isArray(record.tree)) return fail();
  const tree: TreeEntry[] = [];
  for (const item of record.tree as unknown[]) {
    if (typeof item !== 'object' || item === null) return fail();
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== 'string' || typeof entry.mode !== 'string' || typeof entry.type !== 'string' || typeof entry.sha !== 'string') {
      return fail();
    }
    const parsed: TreeEntry = { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha.toLowerCase() };
    if (typeof entry.size === 'number') parsed.size = entry.size;
    tree.push(parsed);
  }
  return { tree, truncated: record.truncated === true };
}

const forbidden = (path: string, kind: SkillEntryProblem) =>
  new BriefstackError('skills.forbiddenEntry', { path: path.slice(0, 200), kind });

/** The blobs of a skill folder listing, checked against every rule before anything is downloaded. */
export function checkEntries(entries: readonly TreeEntry[], truncated: boolean, limits: FetchLimits): { path: string; sha: string; size: number; executable: boolean }[] {
  if (truncated) throw forbidden('', 'truncated');
  const blobs: { path: string; sha: string; size: number; executable: boolean }[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'tree') continue;
    if (entry.type === 'commit' || entry.mode === '160000') throw forbidden(entry.path, 'submodule');
    if (entry.mode === '120000') throw forbidden(entry.path, 'symlink');
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) throw forbidden(entry.path, 'unsafePath');
    const segments = entry.path.split('/');
    if (
      !isSafeRelativePath(entry.path) ||
      entry.path.length > MAX_PATH_LENGTH ||
      segments.length > MAX_DEPTH ||
      segments.some((segment) => segment.toLowerCase() === '.git' || segment.toLowerCase().startsWith('.git~'))
    ) {
      throw forbidden(entry.path, 'unsafePath');
    }
    if (segments.some((segment) => GIT_CONTROL.has(segment.toLowerCase()))) throw forbidden(entry.path, 'gitControl');
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw forbidden(entry.path, 'caseCollision');
    seen.add(key);
    const size = entry.size ?? 0;
    if (size > limits.maxFileBytes) {
      throw new BriefstackError('skills.tooLarge', { what: 'file', limit: limits.maxFileBytes, actual: size, path: entry.path });
    }
    total += size;
    blobs.push({ path: entry.path, sha: entry.sha, size, executable: entry.mode === '100755' });
  }
  // A file and a folder with the same name in another case also collide on Windows and macOS.
  for (const blob of blobs) {
    const parts = blob.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (seen.has(parts.slice(0, i).join('/'))) throw forbidden(blob.path, 'caseCollision');
    }
  }
  if (blobs.length > limits.maxFiles) {
    throw new BriefstackError('skills.tooLarge', { what: 'files', limit: limits.maxFiles, actual: blobs.length });
  }
  if (total > limits.maxTotalBytes) {
    throw new BriefstackError('skills.tooLarge', { what: 'total', limit: limits.maxTotalBytes, actual: total });
  }
  if (!blobs.some((blob) => blob.path === 'SKILL.md')) throw new BriefstackError('skills.noSkillFile', {});
  return blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The tree sha of `folder` under `rootSha`, walking one level per request; the root's entries come along. */
async function walk(
  fetcher: Fetcher,
  owner: string,
  repo: string,
  commit: string,
  folder: string,
): Promise<{ sha: string; rootEntries: TreeEntry[] } | undefined> {
  const root = await fetcher.tree(owner, repo, commit, false);
  if (root === undefined) return undefined;
  let sha = commit;
  let entries = root.tree;
  const segments = folder === '' ? [] : folder.split('/');
  for (const [index, segment] of segments.entries()) {
    const next = entries.find((entry) => entry.path === segment && entry.type === 'tree');
    if (next === undefined) return undefined;
    sha = next.sha;
    // The last folder is listed recursively by the caller.
    if (index === segments.length - 1) break;
    const listing = await fetcher.tree(owner, repo, sha, false);
    if (listing === undefined) return undefined;
    entries = listing.tree;
  }
  return { sha, rootEntries: root.tree };
}

async function download(fetcher: Fetcher, parsed: SkillUrl, commit: string, folder: string, blob: { path: string; sha: string; size: number }): Promise<Buffer> {
  const full = folder === '' ? blob.path : `${folder}/${blob.path}`;
  const bytes = await fetcher.rawFile(parsed.owner, parsed.repo, commit, full, fetcher.limits.maxFileBytes);
  if (bytes.length !== blob.size || gitBlobSha(bytes) !== blob.sha) throw new BriefstackError('skills.integrity', { path: blob.path });
  if (bytes.subarray(0, LFS_POINTER.length).equals(LFS_POINTER)) throw forbidden(blob.path, 'lfs');
  return bytes;
}

/**
 * Fetches the skill a GitHub link points at. Throws coded errors
 * (`skills.*`); on success every file's bytes match the pinned commit.
 */
export async function fetchSkill(url: string, options: FetchOptions = {}): Promise<FetchedSkill> {
  const parsed = parseSkillUrl(url);
  const fetcher = new Fetcher(options);
  let pinnedAny = false;
  let lastMissing: RefCandidate | undefined;
  for (const candidate of refCandidates(parsed)) {
    const commit = await fetcher.pin(parsed.owner, parsed.repo, candidate.ref);
    if (commit === undefined) continue;
    pinnedAny = true;
    const found = await walk(fetcher, parsed.owner, parsed.repo, commit, candidate.path);
    if (found === undefined) {
      lastMissing = candidate;
      continue;
    }
    const listing = await fetcher.tree(parsed.owner, parsed.repo, found.sha, true);
    if (listing === undefined) {
      lastMissing = candidate;
      continue;
    }
    const blobs = checkEntries(listing.tree, listing.truncated, fetcher.limits);
    const files: FetchedFile[] = [];
    for (const blob of blobs) {
      files.push({ path: blob.path, bytes: await download(fetcher, parsed, commit, candidate.path, blob), executable: blob.executable });
    }
    const result: FetchedSkill = { owner: parsed.owner, repo: parsed.repo, ref: candidate.ref, commit, path: candidate.path, url: parsed.url, files };
    if (candidate.path !== '') {
      const license = found.rootEntries.find((entry) => entry.type === 'blob' && entry.mode !== '120000' && LICENSE_NAME.test(entry.path));
      if (license !== undefined && (license.size ?? 0) <= MAX_LICENSE_BYTES) {
        const bytes = await fetcher.rawFile(parsed.owner, parsed.repo, commit, license.path, MAX_LICENSE_BYTES);
        if (gitBlobSha(bytes) === license.sha) result.rootLicense = { path: license.path, bytes };
      }
    }
    return result;
  }
  if (!pinnedAny) throw new BriefstackError('skills.refNotFound', { ref: parsed.rest.join('/') || 'HEAD' });
  throw new BriefstackError('skills.pathNotFound', { path: lastMissing?.path ?? '' });
}

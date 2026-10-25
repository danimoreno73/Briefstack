import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diffHunks, diffLines } from '../chat/diff.js';
import type { DiffHunk } from '../chat/types.js';
import { BriefstackError } from '../errors.js';
import { gitCommit, type GitWarning } from '../library/git.js';
import { withLibraryLock } from '../library/lock.js';
import { assertLibrary, readTextIfExists, secretLines } from '../library/notes.js';
import { fetchSkill, type FetchOptions, type FetchedSkill } from './github.js';
import { modelReview, type SkillModelReviewer } from './modelReview.js';
import {
  FILES_DIR,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  NEXT_DIR,
  SKILL_FORMAT,
  TAG_RE,
  isSkillName,
  parseRecord,
  renderRecord,
  skillNameFrom,
  versionFrom,
  type SkillRecord,
  type SkillStatus,
  type SkillVersion,
} from './record.js';
import type { LibraryHashes } from '../validate/index.js';
import { assertPathsFit } from './pathLength.js';
import { decodeText, reviewSkill, sha256 } from './review.js';
import { parseSkillUrl, treeUrl } from './url.js';

/**
 * The library's third-party skills (BRIEF-phase-6 §3): add from a GitHub
 * link into quarantine, approve, reject, delete, edit tags, check for a new
 * version. Every change runs under the library lock and is one commit of
 * `skills/<name>/`. Nothing here runs anything from a skill.
 */

export const SKILLS_DIR = 'skills';
/** Git options for skill commits: the bytes in the library are the bytes fetched. */
const GIT_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
/** A skill's own `.gitignore` must not keep any of its files out of the commit. */
const GIT_ADD = ['-f'];
const MAX_VIEW_BYTES = 512 * 1024;

export interface SkillServiceOptions {
  /** The library folder, read at each call (Settings may move it). */
  libraryDir: () => Promise<string>;
  fetch?: FetchOptions;
  reviewer?: SkillModelReviewer | undefined;
  now?: () => Date;
}

export interface SkillSummary {
  name: string;
  description: string;
  status: SkillStatus;
  tags: string[];
  /** `owner/repo` and folder. */
  repo: string;
  path: string;
  commit: string;
  link: string;
  hasScripts: boolean;
  network: boolean;
  license: string | null;
  high: number;
  model: SkillVersion['model']['state'];
  /** A new version waits for approval. */
  update: boolean;
  statusChanged: string;
}

export interface FileDiff {
  path: string;
  change: 'added' | 'removed' | 'changed';
  /** For text files that changed. */
  hunks?: DiffHunk[];
  binary?: boolean;
}

export interface SkillDetail {
  record: SkillRecord;
  /** The new version against the current one, when there is one. */
  diff?: FileDiff[];
}

export interface ChangeResult {
  detail: SkillDetail | undefined;
  committed: boolean;
  warnings: GitWarning[];
}

/** What the architect may see of an approved skill: data, nothing else. */
export interface ApprovedSkill {
  name: string;
  description: string;
  tags: string[];
}

const noteFile = (name: string): string => `${SKILLS_DIR}/${name}/${name}.md`;
const native = (libraryDir: string, relative: string): string => path.join(libraryDir, ...relative.split('/'));

function summaryOf(record: SkillRecord): SkillSummary {
  return {
    name: record.name,
    description: record.description,
    status: record.status,
    tags: record.tags,
    repo: record.source.repo,
    path: record.source.path,
    commit: record.source.commit,
    link: record.source.link,
    hasScripts: record.hasScripts,
    network: record.network,
    license: record.license.spdx,
    high: record.findings.filter((f) => f.severity === 'high').length,
    model: record.model.state,
    update: record.next !== undefined,
    statusChanged: record.statusChanged,
  };
}

/** A tag list as the user typed it: trimmed, lower case, distinct; refused when one is not a tag. */
export function normaliseTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag === '') continue;
    if (tag.length > MAX_TAG_LENGTH || !TAG_RE.test(tag)) throw new BriefstackError('skills.invalidTag', { tag: raw.slice(0, 60) });
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new BriefstackError('skills.invalidTag', { tag: `${out.length} tags (at most ${MAX_TAGS})` });
  return out;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Writes every fetched file under `dir`, which must not exist yet. */
async function writeFiles(dir: string, files: FetchedSkill['files']): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: 'wx' });
  }
}

/** Every regular file under `dir`, with `/` paths, and its SHA-256. */
async function hashesOnDisk(dir: string): Promise<{ path: string; sha256: string }[]> {
  const out: { path: string; sha256: string }[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(relative === '' ? dir : path.join(dir, ...relative.split('/')), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push({ path: child, sha256: sha256(await readFile(path.join(dir, ...child.split('/')))) });
    }
  };
  await walk('');
  return out;
}

/** Whether the files on disk under `dir` are exactly the recorded ones (no more, no fewer, same bytes). */
export async function filesMatch(dir: string, files: SkillVersion['files']): Promise<{ ok: true } | { ok: false; path: string }> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(relative === '' ? dir : path.join(dir, ...relative.split('/')), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else found.push(child);
    }
  };
  await walk('');
  const expected = new Map(files.map((file) => [file.path, file]));
  for (const file of found) if (!expected.has(file)) return { ok: false, path: file };
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(dir, ...file.path.split('/')));
    } catch {
      return { ok: false, path: file.path };
    }
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) return { ok: false, path: file.path };
  }
  return { ok: true };
}

export class SkillService {
  private readonly now: () => Date;

  constructor(private readonly options: SkillServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private async library(): Promise<string> {
    const dir = await this.options.libraryDir();
    await assertLibrary(dir);
    return dir;
  }

  private async load(libraryDir: string, name: string): Promise<SkillRecord> {
    if (!isSkillName(name)) throw new BriefstackError('skills.notFound', { name: name.slice(0, 80) });
    const text = await readTextIfExists(native(libraryDir, noteFile(name)));
    if (text === undefined) throw new BriefstackError('skills.notFound', { name });
    const record = parseRecord(text, noteFile(name));
    if (record === undefined || record.name !== name) throw new BriefstackError('skills.unreadable', { name });
    return record;
  }

  /** Writes the note (after the secret check) and commits the skill's folder. */
  private async save(libraryDir: string, record: SkillRecord, message: string): Promise<ChangeResult> {
    const text = renderRecord(record);
    const leaked = secretLines(text);
    if (leaked.length > 0) throw new BriefstackError('library.secretContent', { file: noteFile(record.name), lines: leaked });
    const file = native(libraryDir, noteFile(record.name));
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
    return this.commit(libraryDir, record.name, message, record);
  }

  private async commit(libraryDir: string, name: string, message: string, record: SkillRecord | undefined): Promise<ChangeResult> {
    const commit = await gitCommit(libraryDir, [`${SKILLS_DIR}/${name}`], message, GIT_CONFIG, GIT_ADD);
    return {
      detail: record === undefined ? undefined : await this.detailOf(libraryDir, record),
      committed: commit.committed,
      warnings: commit.warning === undefined ? [] : [commit.warning],
    };
  }

  private async detailOf(libraryDir: string, record: SkillRecord): Promise<SkillDetail> {
    if (record.next === undefined) return { record };
    return { record, diff: await this.diff(libraryDir, record) };
  }

  /** The new version's files against the current ones. */
  private async diff(libraryDir: string, record: SkillRecord): Promise<FileDiff[]> {
    const next = record.next;
    if (next === undefined) return [];
    const base = native(libraryDir, `${SKILLS_DIR}/${record.name}`);
    const before = new Map(record.files.map((f) => [f.path, f]));
    const after = new Map(next.files.map((f) => [f.path, f]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const out: FileDiff[] = [];
    for (const file of paths) {
      const a = before.get(file);
      const b = after.get(file);
      if (a === undefined) out.push({ path: file, change: 'added' });
      else if (b === undefined) out.push({ path: file, change: 'removed' });
      else if (a.sha256 !== b.sha256) {
        if (a.kind === 'binary' || b.kind === 'binary' || a.size > MAX_VIEW_BYTES || b.size > MAX_VIEW_BYTES) {
          out.push({ path: file, change: 'changed', binary: true });
          continue;
        }
        const read = async (dir: string) => (await readTextIfExists(path.join(base, dir, ...file.split('/')))) ?? '';
        out.push({ path: file, change: 'changed', hunks: diffHunks(diffLines(await read(FILES_DIR), await read(NEXT_DIR))) });
      }
    }
    return out;
  }

  /** Every skill note that reads back, by name. */
  async list(): Promise<SkillSummary[]> {
    const libraryDir = await this.library();
    let entries;
    try {
      entries = await readdir(native(libraryDir, SKILLS_DIR), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: SkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSkillName(entry.name)) continue;
      const text = await readTextIfExists(native(libraryDir, noteFile(entry.name)));
      const record = text === undefined ? undefined : parseRecord(text, noteFile(entry.name));
      if (record !== undefined && record.name === entry.name) out.push(summaryOf(record));
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async get(name: string): Promise<SkillDetail> {
    const libraryDir = await this.library();
    return this.detailOf(libraryDir, await this.load(libraryDir, name));
  }

  /** Approved skills only, as the architect sees them. */
  async approvedIndex(): Promise<ApprovedSkill[]> {
    return (await this.list())
      .filter((skill) => skill.status === 'approved')
      .map((skill) => ({ name: skill.name, description: skill.description, tags: skill.tags }));
  }

  /**
   * The hashes of every library skill file, for the validator: the current
   * files of approved skills are approved; the files of skills in quarantine
   * or rejected, and of any new version waiting for approval, are not. A
   * skill folder whose note does not read back counts as unapproved, with
   * the hashes of the files on disk.
   */
  async contentHashes(): Promise<LibraryHashes> {
    const libraryDir = await this.library();
    const approved = new Set<string>();
    const unapproved = new Map<string, { name: string; path: string }>();
    let entries;
    try {
      entries = await readdir(native(libraryDir, SKILLS_DIR), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { approved, unapproved };
      throw error;
    }
    const addUnapproved = (name: string, files: readonly { path: string; sha256: string }[]) => {
      for (const file of files) if (!unapproved.has(file.sha256)) unapproved.set(file.sha256, { name, path: file.path });
    };
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const text = isSkillName(entry.name) ? await readTextIfExists(native(libraryDir, noteFile(entry.name))) : undefined;
      const record = text === undefined ? undefined : parseRecord(text, noteFile(entry.name));
      if (record === undefined || record.name !== entry.name) {
        addUnapproved(entry.name, await hashesOnDisk(native(libraryDir, `${SKILLS_DIR}/${entry.name}`)));
        continue;
      }
      if (record.status === 'approved') for (const file of record.files) approved.add(file.sha256);
      else addUnapproved(record.name, record.files);
      if (record.next !== undefined) addUnapproved(record.name, record.next.files);
    }
    return { approved, unapproved };
  }

  /** One file of a version, for the page; text only up to a size, binaries are not sent. */
  async readFile(name: string, file: string, version: 'current' | 'next' = 'current'): Promise<{ path: string; kind: string; size: number; text?: string }> {
    const libraryDir = await this.library();
    const record = await this.load(libraryDir, name);
    const source = version === 'next' ? record.next : record;
    const entry = source?.files.find((f) => f.path === file);
    if (source === undefined || entry === undefined) throw new BriefstackError('skills.fileNotFound', { name, path: file.slice(0, 200) });
    if (entry.kind === 'binary' || entry.size > MAX_VIEW_BYTES) return { path: entry.path, kind: entry.kind, size: entry.size };
    const dir = version === 'next' ? NEXT_DIR : FILES_DIR;
    const bytes = await readFile(native(libraryDir, `${SKILLS_DIR}/${name}/${dir}/${entry.path}`));
    return { path: entry.path, kind: entry.kind, size: entry.size, text: decodeText(bytes).text };
  }

  /** Fetches, reviews and stores a version; the network and the model run outside the library lock. */
  private async fetchVersion(url: string): Promise<{ fetched: FetchedSkill; version: SkillVersion; frontmatterName: string | undefined }> {
    const fetched = await fetchSkill(url, this.options.fetch);
    const review = reviewSkill({ files: fetched.files, rootLicense: fetched.rootLicense });
    // Every text file goes to the model, decoded as the static review read it.
    const files = review.inventory.flatMap((item) => {
      const file = fetched.files.find((f) => f.path === item.path);
      return item.kind === 'binary' || file === undefined ? [] : [{ path: item.path, kind: item.kind, text: decodeText(file.bytes).text }];
    });
    const model = await modelReview(this.options.reviewer, { files }, this.now);
    const source = {
      url: fetched.url,
      repo: `${fetched.owner}/${fetched.repo}`,
      path: fetched.path,
      ref: fetched.ref,
      commit: fetched.commit,
      link: treeUrl(fetched.owner, fetched.repo, fetched.commit, fetched.path),
    };
    return { fetched, version: versionFrom({ source, fetched: this.now().toISOString(), review, model }), frontmatterName: review.frontmatter.name };
  }

  /** Adds a skill from a GitHub link, in quarantine. Refused when a skill of that name exists. */
  async add(url: string, tags: readonly string[] = []): Promise<ChangeResult> {
    const libraryDir = await this.library();
    const wanted = normaliseTags(tags);
    const parsed = parseSkillUrl(url);
    const { fetched, version, frontmatterName } = await this.fetchVersion(url);
    const folder = fetched.path === '' ? parsed.repo : (fetched.path.split('/').at(-1) as string);
    const name = skillNameFrom([frontmatterName, folder, parsed.repo]);
    if (name === undefined) throw new BriefstackError('skills.invalidName', { name: (frontmatterName ?? folder).slice(0, 80) });

    return withLibraryLock(libraryDir, async () => {
      const dir = native(libraryDir, `${SKILLS_DIR}/${name}`);
      if (await exists(dir)) {
        const current = await readTextIfExists(native(libraryDir, noteFile(name)));
        const record = current === undefined ? undefined : parseRecord(current, noteFile(name));
        const same = record !== undefined && record.source.repo === version.source.repo && record.source.path === version.source.path;
        throw new BriefstackError('skills.exists', { name, sameSource: same });
      }
      const record: SkillRecord = { skillFormat: SKILL_FORMAT, name, status: 'quarantine', tags: wanted, statusChanged: this.now().toISOString(), ...version };
      // Built in a folder of its own and moved into place, so a failure leaves no half-written skill.
      const staging = native(libraryDir, `${SKILLS_DIR}/.${name}.${randomBytes(4).toString('hex')}.tmp`);
      // The staging folder is the longest place a file goes; checked before anything is written.
      assertPathsFit(path.join(staging, FILES_DIR), fetched.files);
      try {
        await writeFiles(path.join(staging, FILES_DIR), fetched.files);
        const text = renderRecord(record);
        const leaked = secretLines(text);
        if (leaked.length > 0) throw new BriefstackError('library.secretContent', { file: noteFile(name), lines: leaked });
        await writeFile(path.join(staging, `${name}.md`), text, 'utf8');
        await rename(staging, dir);
      } catch (error) {
        await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        throw error;
      }
      return this.commit(libraryDir, name, `library: add skill ${name} (quarantine)`, record);
    });
  }

  private async change(name: string, work: (libraryDir: string, record: SkillRecord) => Promise<ChangeResult>): Promise<ChangeResult> {
    const libraryDir = await this.library();
    return withLibraryLock(libraryDir, async () => work(libraryDir, await this.load(libraryDir, name)));
  }

  private wrong(record: SkillRecord, action: string): BriefstackError<'skills.wrongStatus'> {
    return new BriefstackError('skills.wrongStatus', { name: record.name, status: record.status, action });
  }

  /** Approves the current version: only when its files on disk are still the reviewed ones. */
  approve(name: string): Promise<ChangeResult> {
    return this.change(name, async (libraryDir, record) => {
      if (record.status === 'approved') throw this.wrong(record, 'approve');
      const match = await filesMatch(native(libraryDir, `${SKILLS_DIR}/${name}/${FILES_DIR}`), record.files);
      if (!match.ok) throw new BriefstackError('skills.modified', { name, path: match.path });
      return this.save(libraryDir, { ...record, status: 'approved', statusChanged: this.now().toISOString() }, `library: approve skill ${name}`);
    });
  }

  reject(name: string): Promise<ChangeResult> {
    return this.change(name, async (libraryDir, record) => {
      if (record.status === 'rejected') throw this.wrong(record, 'reject');
      return this.save(libraryDir, { ...record, status: 'rejected', statusChanged: this.now().toISOString() }, `library: reject skill ${name}`);
    });
  }

  remove(name: string): Promise<ChangeResult> {
    return this.change(name, async (libraryDir) => {
      await rm(native(libraryDir, `${SKILLS_DIR}/${name}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return this.commit(libraryDir, name, `library: delete skill ${name}`, undefined);
    });
  }

  setTags(name: string, tags: readonly string[]): Promise<ChangeResult> {
    const wanted = normaliseTags(tags);
    return this.change(name, async (libraryDir, record) => {
      if (wanted.join(',') === record.tags.join(',')) return { detail: await this.detailOf(libraryDir, record), committed: false, warnings: [] };
      return this.save(libraryDir, { ...record, tags: wanted }, `library: tag skill ${name}`);
    });
  }

  /**
   * Fetches the latest commit of the ref the skill was added from into
   * quarantine, next to the approved version. Never automatic. `pinned`:
   * the skill was added at a commit, so there is nothing newer to look for.
   */
  async checkUpdate(name: string): Promise<ChangeResult & { outcome: 'updated' | 'upToDate' | 'pinned' }> {
    const libraryDir = await this.library();
    const record = await this.load(libraryDir, name);
    if (record.status !== 'approved') throw this.wrong(record, 'checkUpdate');
    if (record.next !== undefined) throw new BriefstackError('skills.updatePending', { name });
    const ref = record.source.ref;
    const same = { detail: await this.detailOf(libraryDir, record), committed: false, warnings: [] };
    if (/^[0-9a-f]{7,40}$/i.test(ref) && record.source.commit.startsWith(ref.toLowerCase())) return { ...same, outcome: 'pinned' };
    const encode = (value: string) => value.split('/').map(encodeURIComponent).join('/');
    const repoUrl = `https://github.com/${record.source.repo}`;
    const url = ref === 'HEAD' && record.source.path === '' ? repoUrl : `${repoUrl}/tree/${encode(ref)}${record.source.path === '' ? '' : `/${encode(record.source.path)}`}`;
    const { fetched, version } = await this.fetchVersion(url);
    if (fetched.commit === record.source.commit) return { ...same, outcome: 'upToDate' };
    // The user's own link stays the one they gave.
    version.source.url = record.source.url;
    const result = await withLibraryLock(libraryDir, async () => {
      const current = await this.load(libraryDir, name);
      if (current.next !== undefined) throw new BriefstackError('skills.updatePending', { name });
      const nextDir = native(libraryDir, `${SKILLS_DIR}/${name}/${NEXT_DIR}`);
      // In next/ now, in files/ once approved.
      assertPathsFit(nextDir, fetched.files);
      assertPathsFit(native(libraryDir, `${SKILLS_DIR}/${name}/${FILES_DIR}`), fetched.files);
      await rm(nextDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await writeFiles(nextDir, fetched.files);
      return this.save(libraryDir, { ...current, next: version }, `library: new version of skill ${name} (quarantine)`);
    });
    return { ...result, outcome: 'updated' };
  }

  /** The new version replaces the approved one; it is approved by this. */
  approveUpdate(name: string): Promise<ChangeResult> {
    return this.change(name, async (libraryDir, record) => {
      const next = record.next;
      if (next === undefined) throw new BriefstackError('skills.noUpdate', { name });
      const base = native(libraryDir, `${SKILLS_DIR}/${name}`);
      const match = await filesMatch(path.join(base, NEXT_DIR), next.files);
      if (!match.ok) throw new BriefstackError('skills.modified', { name, path: match.path });
      const old = path.join(base, `.old-${randomBytes(4).toString('hex')}`);
      await rename(path.join(base, FILES_DIR), old);
      await rename(path.join(base, NEXT_DIR), path.join(base, FILES_DIR));
      await rm(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      const { next: _dropped, ...rest } = record;
      void _dropped;
      return this.save(libraryDir, { ...rest, ...next, status: 'approved', statusChanged: this.now().toISOString() }, `library: approve new version of skill ${name}`);
    });
  }

  /** Drops the new version; the approved one stays. */
  rejectUpdate(name: string): Promise<ChangeResult> {
    return this.change(name, async (libraryDir, record) => {
      if (record.next === undefined) throw new BriefstackError('skills.noUpdate', { name });
      await rm(native(libraryDir, `${SKILLS_DIR}/${name}/${NEXT_DIR}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      const { next: _dropped, ...rest } = record;
      void _dropped;
      return this.save(libraryDir, rest, `library: reject new version of skill ${name}`);
    });
  }

  /**
   * The approved files of a skill, checked against the stored hashes, for
   * `skills install`. Refused unless approved and intact.
   */
  async approvedFiles(name: string): Promise<{ record: SkillRecord; dir: string }> {
    const libraryDir = await this.library();
    const record = await this.load(libraryDir, name);
    if (record.status !== 'approved') throw new BriefstackError('skills.notApproved', { name, status: record.status });
    const dir = native(libraryDir, `${SKILLS_DIR}/${name}/${FILES_DIR}`);
    const match = await filesMatch(dir, record.files);
    if (!match.ok) throw new BriefstackError('skills.modified', { name, path: match.path });
    return { record, dir };
  }
}

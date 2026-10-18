import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identityArgs } from '../library/git.js';
import { noRepoCodeArgs } from '../scaffold/commit.js';
import { splitFrontmatter } from './text.js';

/**
 * The git side of an improvement (BRIEF-phase-5 §3.2, §3.4; docs/decisions.md,
 * phase 5 H0 #1, #2 and #4). `git` runs through `execFile`, never a shell.
 *
 * Applying and reverting never use `git commit -a`, `git revert` or a
 * checkout in the user's working tree: a temporary index builds the commit
 * from the committed frontmatter and the merged body of each file, the
 * branch moves only if it still points where it was read (compare and swap),
 * and the working files get the same body under their own frontmatter, so
 * uncommitted `usage set` changes stay as they are.
 */

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim().slice(0, 300)}`);
  }
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

function runGit(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      { cwd, env: options.env ?? process.env, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error);
          return;
        }
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export async function git(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) throw new GitError(args, result.stderr);
  return result.stdout;
}

/** The branch `HEAD` is on, or `undefined` when detached. */
export async function currentBranch(repoDir: string): Promise<string | undefined> {
  const result = await runGit(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function revParse(repoDir: string, rev: string): Promise<string> {
  return (await git(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
}

/** A file's text at a commit, or `undefined` when it does not exist there. */
export async function fileAt(repoDir: string, rev: string, file: string): Promise<string | undefined> {
  const result = await runGit(repoDir, ['cat-file', 'blob', `${rev}:${file}`]);
  return result.code === 0 ? result.stdout : undefined;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'other';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Git's file mode at the head side, e.g. `100644`; `undefined` when deleted. */
  mode?: string;
  /** Git's file mode at the base side; `undefined` when added. */
  baseMode?: string;
}

/** Every path that differs between two commits, renames shown as a delete and an add. */
export async function changedFiles(repoDir: string, from: string, to: string): Promise<ChangedFile[]> {
  const raw = await git(repoDir, ['diff', '--raw', '--no-renames', '-z', '--no-abbrev', from, to]);
  const parts = raw.split('\0').filter((part) => part !== '');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = (parts[i] as string).split(' ');
    const letter = (meta[4] ?? '').charAt(0);
    const status: ChangeStatus = letter === 'A' ? 'added' : letter === 'M' ? 'modified' : letter === 'D' ? 'deleted' : 'other';
    const baseMode = (meta[0] ?? '').replace(/^:/, '');
    const mode = meta[1];
    files.push({
      path: parts[i + 1] as string,
      status,
      ...(status === 'deleted' || mode === undefined ? {} : { mode }),
      ...(status === 'added' || baseMode === '' ? {} : { baseMode }),
    });
  }
  return files;
}

// ---- Worktrees ---------------------------------------------------------------

export const NODE_MODULES = 'node_modules';

// Git sees a symlink as a file, so `node_modules/` in .gitignore does not
// ignore the link outside Windows (a junction counts as a directory there).
// Every listing and commit in a worktree leaves it out by name instead.
const NODE_MODULES_PATHSPEC = `:(exclude,top)${NODE_MODULES}`;

/** A new worktree at `dir` on a new branch `branch`, from `base`. */
export async function createWorktree(repoDir: string, dir: string, branch: string, base: string): Promise<void> {
  await mkdir(path.dirname(dir), { recursive: true });
  await git(repoDir, ['worktree', 'add', '--quiet', '-b', branch, dir, base]);
}

/** Links the repo's `node_modules` into the worktree: a junction on Windows (no rights needed), a symlink elsewhere. */
export async function linkNodeModules(repoDir: string, worktreeDir: string): Promise<void> {
  const link = path.join(worktreeDir, NODE_MODULES);
  await unlinkNodeModules(worktreeDir);
  await symlink(path.join(repoDir, NODE_MODULES), link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Removes the link only, never what it points to. */
export async function unlinkNodeModules(worktreeDir: string): Promise<void> {
  const link = path.join(worktreeDir, NODE_MODULES);
  let info;
  try {
    info = await lstat(link);
  } catch {
    return;
  }
  if (!info.isSymbolicLink()) throw new Error(`${NODE_MODULES} in the worktree is not a link; it was left alone.`);
  // A junction is removed like a directory on Windows; a symlink with unlink.
  try {
    await unlink(link);
  } catch {
    await rmdir(link);
  }
}

/** Removes the worktree (its link first) and the branch. What is already gone is fine. */
export async function removeWorktree(repoDir: string, dir: string, branch: string): Promise<void> {
  await unlinkNodeModules(dir).catch(() => undefined);
  await runGit(repoDir, ['worktree', 'remove', '--force', dir]);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await runGit(repoDir, ['worktree', 'prune']);
  await runGit(repoDir, ['branch', '-D', branch]);
}

/**
 * Runs `task` with `-c` options under which git runs nothing the repo's
 * config names: hooks are looked up in an empty folder, the filesystem
 * monitor is off, and every configured filter driver is blanked, so a
 * `.gitattributes` in the worktree cannot start one.
 */
async function withoutRepoCode<T>(worktreeDir: string, task: (configArgs: string[]) => Promise<T>): Promise<T> {
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-no-hooks-'));
  try {
    const configArgs = noRepoCodeArgs(emptyDir);
    const listed = await runGit(worktreeDir, [...configArgs, 'config', '--name-only', '--get-regexp', '^filter\\.']);
    const drivers = new Set(listed.stdout.split(/\r?\n/).flatMap((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1] ?? []));
    for (const driver of drivers) {
      configArgs.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
    }
    return await task(configArgs);
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
}

/**
 * Commits everything in the worktree on its branch, as one round, without
 * running anything from the repo's config (`withoutRepoCode`). Returns the
 * new commit, or `undefined` when nothing changed.
 */
export async function commitWorktree(worktreeDir: string, message: string): Promise<string | undefined> {
  return withoutRepoCode(worktreeDir, async (configArgs) => {
    await git(worktreeDir, [...configArgs, 'add', '-A']);
    await git(worktreeDir, [...configArgs, 'rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', NODE_MODULES]);
    if ((await git(worktreeDir, [...configArgs, 'status', '--porcelain', '--', '.', NODE_MODULES_PATHSPEC])).trim() === '') return undefined;
    await git(worktreeDir, [...configArgs, ...(await identityArgs(worktreeDir, configArgs)), 'commit', '--quiet', '-m', message]);
    return revParse(worktreeDir, 'HEAD');
  });
}

/** Paths in the worktree git does not track and does not ignore. */
export async function untrackedFiles(worktreeDir: string): Promise<string[]> {
  const raw = await withoutRepoCode(worktreeDir, (configArgs) =>
    git(worktreeDir, [...configArgs, 'ls-files', '--others', '--exclude-standard', `--exclude=/${NODE_MODULES}`, '-z']),
  );
  return raw.split('\0').filter((part) => part !== '');
}

/** Paths in the worktree git ignores (folders end in `/`), apart from the `node_modules` link. */
export async function ignoredFiles(worktreeDir: string): Promise<string[]> {
  const raw = await withoutRepoCode(worktreeDir, (configArgs) =>
    git(worktreeDir, [...configArgs, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
  );
  return raw.split('\0').filter((part) => part !== '' && part.replace(/\/$/, '') !== NODE_MODULES);
}

/**
 * Moves the worktree's branch to `tip` (the current tip of the branch the
 * proposal applies to) and writes back each proposed file merged onto its
 * text at `tip`. A file that no longer merges keeps its text at `tip` and is
 * listed in `dropped`. Nothing here is validated: the next round's commit
 * is, against `tip`.
 */
export async function moveWorktree(
  worktreeDir: string,
  tip: string,
  files: readonly { path: string; base: string; proposed: string }[],
): Promise<{ dropped: string[] }> {
  await withoutRepoCode(worktreeDir, (configArgs) => git(worktreeDir, [...configArgs, 'reset', '--quiet', '--hard', tip]));
  const dropped: string[] = [];
  for (const file of files) {
    const current = await fileAt(worktreeDir, tip, file.path);
    const merged = current === undefined ? undefined : await mergeText(current, file.base, file.proposed);
    if (merged === undefined) {
      dropped.push(file.path);
      continue;
    }
    await writeFile(path.join(worktreeDir, ...file.path.split('/')), merged, 'utf8');
  }
  return { dropped };
}

/**
 * Removes what git ignores in the worktree (the build output of a check), so
 * the next round starts with nothing outside git. Skipped while anything is
 * still at `node_modules`, so a link is never followed.
 */
export async function cleanIgnored(worktreeDir: string): Promise<void> {
  try {
    await lstat(path.join(worktreeDir, NODE_MODULES));
    return;
  } catch {
    // Nothing there: safe to clean.
  }
  await withoutRepoCode(worktreeDir, (configArgs) => git(worktreeDir, [...configArgs, 'clean', '-fdXq']));
}

// ---- Apply and revert ---------------------------------------------------------

export interface BodyChange {
  /** Repo-relative, with `/`. */
  path: string;
  /** Only the text after the frontmatter is taken from `base` and `proposed`. */
  bodyOnly: boolean;
  /** The file as the proposal started from it. */
  base: string;
  /** The file as the proposal wants it. */
  proposed: string;
}

export type ApplyRefusal =
  /** The repo is not on `branch`. */
  | { reason: 'wrongBranch'; current: string | undefined }
  /** The file is gone from the branch. */
  | { reason: 'missing'; path: string }
  /** The working file differs from the branch in the part that would change. */
  | { reason: 'uncommitted'; path: string }
  /** The branch changed the same lines. */
  | { reason: 'conflict'; path: string }
  /** Strict only: the branch changed the part that would change since the proposal's base. */
  | { reason: 'baseChanged'; path: string }
  /** The branch moved while the commit was being made. */
  | { reason: 'moved' };

export type ApplyResult = { ok: true; commit: string; files: string[] } | ({ ok: false } & ApplyRefusal);

/** Three-way merge of one text with `git merge-file`: `undefined` on a conflict. */
export async function mergeText(current: string, base: string, proposed: string): Promise<string | undefined> {
  if (current === base) return proposed;
  if (proposed === base || proposed === current) return current;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-merge-'));
  try {
    const files = ['current', 'base', 'proposed'].map((name) => path.join(dir, name));
    await Promise.all([writeFile(files[0] as string, current), writeFile(files[1] as string, base), writeFile(files[2] as string, proposed)]);
    const result = await runGit(dir, ['merge-file', '-p', ...files]);
    return result.code === 0 ? result.stdout : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const part = (text: string, bodyOnly: boolean) => (bodyOnly ? splitFrontmatter(text) : { head: '', body: text });

/**
 * One commit on `branch` with the changes, keeping each file's committed
 * frontmatter in the commit and its working frontmatter on disk (H0 #4).
 * Refused, with nothing changed, if the repo is not on `branch`, a file has
 * uncommitted changes in the part that would change, a body no longer
 * merges, or the branch moves meanwhile.
 *
 * `strict` (approving a proposal): the part that would change must be on
 * the branch exactly as in the proposal's base, so the commit holds what was
 * validated and tested; no three-way merge. Reverting is not strict.
 */
export async function applyChanges(
  repoDir: string,
  branch: string,
  changes: readonly BodyChange[],
  message: string,
  options: { strict?: boolean } = {},
): Promise<ApplyResult> {
  const current = await currentBranch(repoDir);
  if (current !== branch) return { ok: false, reason: 'wrongBranch', current };
  const head = await revParse(repoDir, `refs/heads/${branch}`);
  const planned: { path: string; committed: string; working: string; mode: string }[] = [];
  for (const change of changes) {
    const atHead = await fileAt(repoDir, head, change.path);
    if (atHead === undefined) return { ok: false, reason: 'missing', path: change.path };
    let onDisk: string;
    try {
      onDisk = await readFile(path.join(repoDir, ...change.path.split('/')), 'utf8');
    } catch {
      return { ok: false, reason: 'uncommitted', path: change.path };
    }
    const headParts = part(atHead, change.bodyOnly);
    const diskParts = part(onDisk, change.bodyOnly);
    if (diskParts.body !== headParts.body) return { ok: false, reason: 'uncommitted', path: change.path };
    if (options.strict === true && headParts.body !== part(change.base, change.bodyOnly).body) return { ok: false, reason: 'baseChanged', path: change.path };
    const merged = await mergeText(headParts.body, part(change.base, change.bodyOnly).body, part(change.proposed, change.bodyOnly).body);
    if (merged === undefined) return { ok: false, reason: 'conflict', path: change.path };
    const mode = (await git(repoDir, ['ls-tree', head, '--', change.path])).split(' ')[0] || '100644';
    planned.push({ path: change.path, committed: headParts.head + merged, working: diskParts.head + merged, mode });
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), 'briefstack-index-'));
  let commit: string;
  const blobs = new Map<string, string>();
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') };
    await git(repoDir, ['read-tree', head], { env });
    for (const item of planned) {
      const blob = (await git(repoDir, ['hash-object', '-w', '--stdin', `--path=${item.path}`], { input: item.committed })).trim();
      blobs.set(item.path, blob);
      await git(repoDir, ['update-index', '--cacheinfo', `${item.mode},${blob},${item.path}`], { env });
    }
    const tree = (await git(repoDir, ['write-tree'], { env })).trim();
    commit = (await git(repoDir, [...(await identityArgs(repoDir)), 'commit-tree', tree, '-p', head, '-m', message])).trim();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  // Compare and swap: refused if the branch moved since `head` was read.
  const swap = await runGit(repoDir, ['update-ref', '-m', message.split('\n')[0] ?? 'improvement', `refs/heads/${branch}`, commit, head]);
  if (swap.code !== 0) return { ok: false, reason: 'moved' };
  for (const item of planned) {
    await writeFile(path.join(repoDir, ...item.path.split('/')), item.working, 'utf8');
    // The index follows the commit for this file, so a frontmatter change stays unstaged.
    await git(repoDir, ['update-index', '--cacheinfo', `${item.mode},${blobs.get(item.path) ?? ''},${item.path}`]);
  }
  return { ok: true, commit, files: planned.map((item) => item.path) };
}

/** The changes that undo `commit` for the given files: from its text back to its parent's. */
export async function revertChangesOf(repoDir: string, commit: string, files: readonly { path: string; bodyOnly: boolean }[]): Promise<BodyChange[]> {
  const changes: BodyChange[] = [];
  for (const file of files) {
    const after = await fileAt(repoDir, commit, file.path);
    const before = await fileAt(repoDir, `${commit}^`, file.path);
    if (after === undefined || before === undefined) continue;
    changes.push({ path: file.path, bodyOnly: file.bodyOnly, base: after, proposed: before });
  }
  return changes;
}

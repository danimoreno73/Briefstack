import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identityArgs } from '../library/git.js';

/**
 * The server's git for tasks (BRIEF-phase-7 §3.2, §3.5; PLAN-phase-7 §1, 4
 * and 5). Git runs through `execFile`, never a shell, and never runs code
 * from the project: every command gets `core.hooksPath` pointing at an empty
 * folder, `core.fsmonitor=false`, every configured filter driver blanked,
 * and `core.longpaths=true` (without it, git on Windows skips a path over
 * 260 characters and still exits 0: decisions.md, "Phase 7: H0", 4).
 */

/** `git merge-tree --write-tree` came in git 2.38. */
export const MIN_GIT_VERSION = [2, 38] as const;

/** The project files a task's worktree never holds (PLAN-phase-7 §1, 1): hidden with `--skip-worktree`. */
export const HIDDEN_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;

/** Environment variables that would point git at another repository, index or object store. */
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];

export class TaskGitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(`git ${args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? ''} failed: ${stderr.trim().slice(0, 300)}`);
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  return env;
}

/** Runs git; a non-zero exit is a result, a missing git an exception (`ENOENT`). */
export function runGit(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      { cwd, env: gitEnv(), windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error);
          return;
        }
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function gitOk(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await runGit(cwd, args, input);
  if (result.code !== 0) throw new TaskGitError(args, result.stderr, result.code);
  return result.stdout;
}

/**
 * Runs `task` with the `-c` options under which git runs nothing the
 * repository names: hooks from an empty folder made for this call, no
 * filesystem monitor, every filter driver blanked, long paths on.
 */
export async function withSafeGit<T>(repoDir: string, task: (git: (args: readonly string[], input?: string) => Promise<string>, run: (args: readonly string[]) => Promise<GitResult>) => Promise<T>): Promise<T> {
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-no-hooks-'));
  try {
    const configArgs = ['-c', `core.hooksPath=${emptyDir}`, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true'];
    const listed = await runGit(repoDir, [...configArgs, 'config', '--name-only', '--get-regexp', '^filter\\.']);
    const drivers = new Set(listed.stdout.split(/\r?\n/).flatMap((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1] ?? []));
    for (const driver of drivers) {
      configArgs.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
    }
    return await task(
      (args, input) => gitOk(repoDir, [...configArgs, ...args], input),
      (args) => runGit(repoDir, [...configArgs, ...args]),
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
}

export interface GitVersion {
  major: number;
  minor: number;
  text: string;
}

/** The installed git's version, or `undefined` when git cannot be run. */
export async function gitVersion(): Promise<GitVersion | undefined> {
  try {
    const result = await runGit(os.tmpdir(), ['--version']);
    const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
    if (result.code !== 0 || match === null) return undefined;
    return { major: Number(match[1]), minor: Number(match[2]), text: `${match[1]}.${match[2]}` };
  } catch {
    return undefined;
  }
}

export function gitIsRecentEnough(version: GitVersion): boolean {
  const [major, minor] = MIN_GIT_VERSION;
  return version.major > major || (version.major === major && version.minor >= minor);
}

export interface RepoState {
  /** The folder is inside a git work tree. */
  inRepo: boolean;
  /** The folder is the top of that work tree (not a subfolder of another repository). */
  isTop: boolean;
  /** The last commit of `HEAD`, when there is one. */
  head?: string;
  /** The branch checked out; absent when `HEAD` is detached or there is no repository. */
  branch?: string;
}

/** Whether two folders are the same once links are resolved; case is ignored where the file system ignores it. */
async function samePath(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([realpath(a), realpath(b)]);
    const fold = process.platform === 'win32' || process.platform === 'darwin' ? (value: string) => value.toLowerCase() : (value: string) => value;
    return fold(path.resolve(left)) === fold(path.resolve(right));
  } catch {
    return false;
  }
}

/** What git says of a project folder: repository, top level, last commit, branch. */
export async function repoState(dir: string): Promise<RepoState> {
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { inRepo: false, isTop: false };
  const top = (await runGit(dir, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const isTop = top !== '' && (await samePath(top, dir));
  const state: RepoState = { inRepo: true, isTop };
  const head = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code === 0 && head.stdout.trim() !== '') state.head = head.stdout.trim();
  const branch = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code === 0 && branch.stdout.trim() !== '') state.branch = branch.stdout.trim();
  return state;
}

/**
 * The paths `git status` reports in the folder: changed, staged and
 * untracked files that are not ignored. Empty when the folder is clean.
 */
export async function uncommittedPaths(dir: string): Promise<string[]> {
  return withSafeGit(dir, async (git) => {
    const raw = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return raw
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3));
  });
}

export interface WorktreeCreated {
  /** The settings files that were tracked and are hidden in the worktree. */
  hidden: string[];
}

/**
 * A worktree at `worktreeDir` on a new branch `branch` from `base`, with the
 * project's settings files hidden: `--skip-worktree` in the worktree's own
 * index and the file deleted there only, so the session never reads them,
 * `git add -A` never stages their deletion, and the project folder keeps
 * them (verified, decisions.md "Phase 7: H0", 1).
 */
export async function createTaskWorktree(projectDir: string, worktreeDir: string, branch: string, base: string): Promise<WorktreeCreated> {
  await withSafeGit(projectDir, (git) => git(['worktree', 'add', '--quiet', '-b', branch, worktreeDir, base]));
  return withSafeGit(worktreeDir, async (git) => {
    const tracked = (await git(['ls-files', '-z', '--', ...HIDDEN_SETTINGS_FILES])).split('\0').filter((file) => file !== '');
    if (tracked.length > 0) await git(['update-index', '--skip-worktree', '--', ...tracked]);
    for (const file of tracked) await rm(path.join(worktreeDir, ...file.split('/')), { force: true });
    return { hidden: tracked };
  });
}

/** Removes the worktree and its branch, and prunes what git keeps of it. What is already gone is fine. */
export async function removeTaskWorktree(projectDir: string, worktreeDir: string, branch: string): Promise<void> {
  await withSafeGit(projectDir, async (_git, run) => {
    await run(['worktree', 'remove', '--force', worktreeDir]);
    await run(['worktree', 'prune']);
    await run(['branch', '-D', '--', branch]);
  });
  await rm(worktreeDir, { recursive: true, force: true });
}

/** A file's bytes at a commit as git stores them (no filter, no text conversion), or `undefined` when it is not there. */
export async function fileAtCommit(repoDir: string, commit: string, file: string): Promise<string | undefined> {
  const result = await runGit(repoDir, ['cat-file', 'blob', `${commit}:${file}`]);
  return result.code === 0 ? result.stdout : undefined;
}

/** The files git tracks in a folder, with `/`. */
export async function trackedFiles(dir: string): Promise<string[]> {
  return withSafeGit(dir, async (git) => (await git(['ls-files', '-z'])).split('\0').filter((file) => file !== ''));
}

/**
 * Commits everything in the worktree on the task's branch, as one round
 * (`git add -A` respects the project's `.gitignore`; the hidden settings
 * files stay out). Returns the new commit, or `undefined` when nothing
 * changed.
 */
export async function commitRound(worktreeDir: string, message: string): Promise<string | undefined> {
  return withSafeGit(worktreeDir, async (git) => {
    await git(['add', '-A']);
    if ((await git(['status', '--porcelain'])).trim() === '') return undefined;
    const identity = await identityArgs(worktreeDir);
    await git([...identity, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', message]);
    return (await git(['rev-parse', 'HEAD'])).trim();
  });
}

/** Message of the commit that makes a project folder a repository for tasks (BRIEF-phase-7 §3.1). */
export const INIT_COMMIT_MESSAGE = 'Start version control for briefstack tasks';

/**
 * Makes a folder a git repository with one commit of its current files
 * (`git add` respects its `.gitignore`). Nothing from the folder runs.
 * Returns the commit.
 */
export async function initRepoWithCommit(dir: string): Promise<string> {
  await gitOk(dir, ['init', '--quiet']);
  return withSafeGit(dir, async (git) => {
    await git(['add', '-A']);
    const identity = await identityArgs(dir);
    await git([...identity, 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', INIT_COMMIT_MESSAGE]);
    return (await git(['rev-parse', 'HEAD'])).trim();
  });
}

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Git operations on the personal library. `git` runs through `execFile`
 * without a shell. Failures never abort a library change: they come back as
 * warnings so the CLI can report them and continue.
 */

const execFileAsync = promisify(execFile);

export type GitWarning =
  | { code: 'gitUnavailable' }
  | { code: 'gitFailed'; detail: string }
  | { code: 'notAGitRepo'; dir: string };

/** Identity used for a commit when the user has none configured. Never written to git config. */
export const FALLBACK_IDENTITY = { name: 'briefstack', email: 'briefstack@localhost' } as const;

/** Runs `git` in `cwd` and returns its stdout; rejects when git fails or is missing. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export function toWarning(error: unknown): GitWarning {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { code: 'gitUnavailable' };
  const detail = (error as { stderr?: string }).stderr?.trim() || String(error);
  return { code: 'gitFailed', detail };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return exists(path.join(dir, '.git'));
}

/** `git init` unless `.git` already exists. */
export async function gitInit(dir: string): Promise<{ initialised: boolean; warning?: GitWarning }> {
  if (await isGitRepo(dir)) return { initialised: false };
  try {
    await git(dir, ['init', '--quiet']);
    return { initialised: true };
  } catch (error) {
    return { initialised: false, warning: toWarning(error) };
  }
}

async function hasConfig(dir: string, key: string, configArgs: readonly string[]): Promise<boolean> {
  try {
    return (await git(dir, [...configArgs, 'config', '--get', key])).trim() !== '';
  } catch {
    return false;
  }
}

/** `-c` options with the fallback identity when the repo has none configured; empty otherwise. */
export async function identityArgs(dir: string, configArgs: readonly string[] = []): Promise<string[]> {
  return (await hasConfig(dir, 'user.name', configArgs)) && (await hasConfig(dir, 'user.email', configArgs))
    ? []
    : ['-c', `user.name=${FALLBACK_IDENTITY.name}`, '-c', `user.email=${FALLBACK_IDENTITY.email}`];
}

/**
 * Date (YYYY-MM-DD, author date) of the commit that first added `file`
 * (relative, with `/`), or `undefined` without git, repo or such commit.
 */
export async function gitFirstAddedDate(dir: string, file: string): Promise<string | undefined> {
  if (!(await isGitRepo(dir))) return undefined;
  try {
    const lines = (await git(dir, ['log', '--diff-filter=A', '--format=%as', '--', file])).trim().split(/\r?\n/);
    // Newest first: a note deleted and added again keeps its first date.
    const oldest = lines.at(-1)?.trim() ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(oldest) ? oldest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `git status` shows anything to commit (untracked files included).
 * `configArgs` are `-c` options put before the command, as in `gitCommit`.
 */
export async function gitHasChanges(
  dir: string,
  configArgs: readonly string[] = [],
): Promise<{ changes: boolean; warning?: GitWarning }> {
  try {
    return { changes: (await git(dir, [...configArgs, 'status', '--porcelain'])).trim() !== '' };
  } catch (error) {
    return { changes: false, warning: toWarning(error) };
  }
}

/**
 * Commits exactly `files` (relative to `dir`, with `/`). Without a configured
 * identity it passes the fallback with `-c` for this command only.
 * `configArgs` are more `-c` options for every git call it makes; `addArgs`
 * go to `git add` (`-f` for a third-party skill, whose own `.gitignore` must
 * not hide its files).
 */
export async function gitCommit(
  dir: string,
  files: readonly string[],
  message: string,
  configArgs: readonly string[] = [],
  addArgs: readonly string[] = [],
): Promise<{ committed: boolean; warning?: GitWarning }> {
  if (files.length === 0) return { committed: false };
  if (!(await isGitRepo(dir))) return { committed: false, warning: { code: 'notAGitRepo', dir } };
  try {
    await git(dir, [...configArgs, 'add', ...addArgs, '--', ...files]);
    await git(dir, [...configArgs, ...(await identityArgs(dir, configArgs)), 'commit', '--quiet', '-m', message, '--', ...files]);
    return { committed: true };
  } catch (error) {
    return { committed: false, warning: toWarning(error) };
  }
}

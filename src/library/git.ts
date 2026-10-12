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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true });
  return stdout;
}

function toWarning(error: unknown): GitWarning {
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

async function hasConfig(dir: string, key: string): Promise<boolean> {
  try {
    return (await git(dir, ['config', '--get', key])).trim() !== '';
  } catch {
    return false;
  }
}

/** Whether `git status` shows anything to commit (untracked files included). */
export async function gitHasChanges(dir: string): Promise<{ changes: boolean; warning?: GitWarning }> {
  try {
    return { changes: (await git(dir, ['status', '--porcelain'])).trim() !== '' };
  } catch (error) {
    return { changes: false, warning: toWarning(error) };
  }
}

/**
 * Commits exactly `files` (relative to `dir`, with `/`). Without a configured
 * identity it passes the fallback with `-c` for this command only.
 */
export async function gitCommit(
  dir: string,
  files: readonly string[],
  message: string,
): Promise<{ committed: boolean; warning?: GitWarning }> {
  if (files.length === 0) return { committed: false };
  if (!(await isGitRepo(dir))) return { committed: false, warning: { code: 'notAGitRepo', dir } };
  try {
    await git(dir, ['add', '--', ...files]);
    const identity =
      (await hasConfig(dir, 'user.name')) && (await hasConfig(dir, 'user.email'))
        ? []
        : ['-c', `user.name=${FALLBACK_IDENTITY.name}`, '-c', `user.email=${FALLBACK_IDENTITY.email}`];
    await git(dir, [...identity, 'commit', '--quiet', '-m', message, '--', ...files]);
    return { committed: true };
  } catch (error) {
    return { committed: false, warning: toWarning(error) };
  }
}

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { git, identityArgs, isGitRepo } from './git.js';

/**
 * The personal library's git history, and undoing one change with
 * `git revert` (BRIEF-phase-1 §3.4: "keep it a local git repo so changes can
 * be undone"). `git` runs through `execFile`, never a shell.
 */

export interface LibraryCommit {
  sha: string;
  shortSha: string;
  /** Author date, strict ISO 8601. */
  date: string;
  subject: string;
  /** Files the commit touched, relative with `/`. */
  files: string[];
}

export const DEFAULT_HISTORY_LIMIT = 50;

const RECORD = '\x1e';
const FIELD = '\x1f';
const SHA_RE = /^[0-9a-f]{4,64}$/i;

/** Parses `git log --name-only` output written with the format in `libraryHistory`. */
export function parseHistory(output: string): LibraryCommit[] {
  const commits: LibraryCommit[] = [];
  for (const record of output.split(RECORD)) {
    const [header = '', ...rest] = record.split(/\r?\n/);
    const [sha, shortSha, date, subject] = header.split(FIELD);
    if (sha === undefined || shortSha === undefined || date === undefined || subject === undefined) continue;
    if (!SHA_RE.test(sha)) continue;
    const files = rest.map((line) => line.trim()).filter((line) => line !== '');
    commits.push({ sha, shortSha, date, subject, files });
  }
  return commits;
}

/**
 * The latest `limit` commits of the library, newest first. A library that
 * is not a git repo, has no commits yet, or has no git to read it with has
 * no history.
 */
export async function libraryHistory(
  libraryDir: string,
  options: { limit?: number } = {},
): Promise<LibraryCommit[]> {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  if (!(await isGitRepo(libraryDir))) return [];
  let output: string;
  try {
    output = await git(libraryDir, [
      '-c',
      'core.quotePath=false',
      'log',
      `--max-count=${limit}`,
      '--name-only',
      // Separators as git placeholders: no control characters on the command line.
      '--format=%x1e%H%x1f%h%x1f%aI%x1f%s',
    ]);
  } catch {
    return [];
  }
  return parseHistory(output);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommit(libraryDir: string, sha: string): Promise<string> {
  if (!SHA_RE.test(sha) || !(await isGitRepo(libraryDir))) {
    throw new BriefstackError('library.commitNotFound', { sha });
  }
  try {
    return (await git(libraryDir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim();
  } catch {
    throw new BriefstackError('library.commitNotFound', { sha });
  }
}

function gitDetail(error: unknown): string {
  return (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

/**
 * Undoes one library commit with a new commit (`git revert --no-edit`) and
 * returns the new commit's sha. Refused when the commit is unknown or when
 * tracked files have uncommitted changes. Untracked files (an Obsidian
 * `.obsidian/` folder, for instance) do not block it: git itself refuses a
 * revert that would overwrite one. On a conflict the revert is aborted, so
 * the library is left as it was.
 */
export async function revertLibraryCommit(libraryDir: string, sha: string): Promise<string> {
  const full = await resolveCommit(libraryDir, sha);
  const status = await git(libraryDir, ['status', '--porcelain', '--untracked-files=no']);
  if (status.trim() !== '') throw new BriefstackError('library.dirtyTree', { dir: libraryDir });

  try {
    await git(libraryDir, [...(await identityArgs(libraryDir)), 'revert', '--no-edit', full]);
  } catch (error) {
    let files: string[] = [];
    try {
      files = (await git(libraryDir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U']))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
    } catch {
      // Reported below as a failed revert.
    }
    if (await exists(path.join(libraryDir, '.git', 'REVERT_HEAD'))) {
      try {
        await git(libraryDir, ['revert', '--abort']);
      } catch {
        // Nothing more to undo.
      }
    }
    if (files.length > 0) throw new BriefstackError('library.revertConflict', { sha: full, files });
    throw new BriefstackError('library.revertFailed', { sha: full, detail: gitDetail(error) });
  }
  return (await git(libraryDir, ['rev-parse', 'HEAD'])).trim();
}

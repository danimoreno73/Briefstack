import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { git, gitCommit, gitHasChanges, isGitRepo, type GitWarning } from '../library/git.js';

/** Message of the commit that closes a creation (user decision, rehearsal run A). */
export const PROJECT_COMMIT_MESSAGE = 'Prepare the project with briefstack';

export interface ProjectCommitResult {
  projectDir: string;
  committed: boolean;
  /** True when git had nothing to commit. */
  nothingToCommit: boolean;
  /** The new commit's id, when one was made and could be read (phase 10). */
  commit?: string;
  warning?: GitWarning;
}

/**
 * `-c` options that keep a project's own `.git` from running anything while
 * briefstack commits: hooks are looked up in `emptyDir`, a folder made empty
 * for this commit (an existing, empty folder works the same on Windows and
 * POSIX), and the filesystem monitor is off.
 */
export function noRepoCodeArgs(emptyDir: string): string[] {
  return ['-c', `core.hooksPath=${emptyDir}`, '-c', 'core.fsmonitor=false'];
}

/** The head's commit id, or `undefined` when it cannot be read. */
async function gitHead(dir: string, configArgs: readonly string[]): Promise<string | undefined> {
  try {
    const id = (await git(dir, [...configArgs, 'rev-parse', '--verify', 'HEAD'])).trim();
    return /^[0-9a-f]{7,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Commits everything in a project briefstack generated (`git add` respects
 * its `.gitignore`), so the user starts from a clean tree. Refuses a folder
 * without `.briefstack/profile.json`. Git problems come back as a warning.
 * Hooks and `core.fsmonitor` in the project's `.git` never run.
 */
export async function commitProject(projectDir: string, options: { message?: string } = {}): Promise<ProjectCommitResult> {
  const dir = path.resolve(projectDir);
  try {
    await stat(path.join(dir, '.briefstack', 'profile.json'));
  } catch (error) {
    throw new BriefstackError('usage.notABriefstackProject', { dir }, { cause: error });
  }
  const base = { projectDir: dir, committed: false, nothingToCommit: false };
  if (!(await isGitRepo(dir))) return { ...base, warning: { code: 'notAGitRepo', dir } };
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-no-hooks-'));
  try {
    const configArgs = noRepoCodeArgs(emptyDir);
    const status = await gitHasChanges(dir, configArgs);
    if (status.warning !== undefined) return { ...base, warning: status.warning };
    if (!status.changes) return { ...base, nothingToCommit: true };
    const commit = await gitCommit(dir, ['.'], options.message ?? PROJECT_COMMIT_MESSAGE, configArgs);
    if (commit.warning !== undefined) return { ...base, warning: commit.warning };
    const head = commit.committed ? await gitHead(dir, configArgs) : undefined;
    return { ...base, committed: commit.committed, ...(head === undefined ? {} : { commit: head }) };
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
}

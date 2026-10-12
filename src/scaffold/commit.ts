import { stat } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { gitCommit, gitHasChanges, isGitRepo, type GitWarning } from '../library/git.js';

/** Message of the commit that closes a creation (user decision, rehearsal run A). */
export const PROJECT_COMMIT_MESSAGE = 'Prepare the project with briefstack';

export interface ProjectCommitResult {
  projectDir: string;
  committed: boolean;
  /** True when git had nothing to commit. */
  nothingToCommit: boolean;
  warning?: GitWarning;
}

/**
 * Commits everything in a project briefstack generated (`git add` respects
 * its `.gitignore`), so the user starts from a clean tree. Refuses a folder
 * without `.briefstack/profile.json`. Git problems come back as a warning.
 */
export async function commitProject(projectDir: string): Promise<ProjectCommitResult> {
  const dir = path.resolve(projectDir);
  try {
    await stat(path.join(dir, '.briefstack', 'profile.json'));
  } catch (error) {
    throw new BriefstackError('usage.notABriefstackProject', { dir }, { cause: error });
  }
  const base = { projectDir: dir, committed: false, nothingToCommit: false };
  if (!(await isGitRepo(dir))) return { ...base, warning: { code: 'notAGitRepo', dir } };
  const status = await gitHasChanges(dir);
  if (status.warning !== undefined) return { ...base, warning: status.warning };
  if (!status.changes) return { ...base, nothingToCommit: true };
  const commit = await gitCommit(dir, ['.'], PROJECT_COMMIT_MESSAGE);
  return commit.warning === undefined ? { ...base, committed: commit.committed } : { ...base, warning: commit.warning };
}

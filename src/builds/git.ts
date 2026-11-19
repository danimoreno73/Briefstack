import { BriefstackError } from '../errors.js';
import { identityArgs } from '../library/git.js';
import { branchHead, withSafeGit } from '../tasks/git.js';

/**
 * The integration branch of a build (BRIEF-phase-9 §3.3; decisions.md,
 * "Phase 9: H0", 1). It lives in the project's repository and is never
 * checked out in the user's folder: it is made, moved and removed with
 * `update-ref`, each time against the value the server last read (a
 * compare and swap), and commits for it are made with `commit-tree`.
 * Git runs as the task's git does: no hooks, no filters, no monitor.
 */

/** Makes `refs/heads/<branch>` at `base`; refused when the branch already exists. */
export async function createIntegrationBranch(projectDir: string, branch: string, base: string): Promise<void> {
  await withSafeGit(projectDir, async (git, run) => {
    await git(['check-ref-format', '--branch', branch]);
    // An empty old value: the ref must not exist (whatever the repository's hash format).
    const result = await run(['update-ref', `refs/heads/${branch}`, base, '']);
    if (result.code !== 0) throw new BriefstackError('build.branchExists', { branch });
  });
}

/**
 * The commits reachable from `head` but not from `base` (the build's whole
 * history on its branch), or `undefined` when git cannot say (no base, or
 * `base` is not an ancestor of `head`).
 */
export async function commitsSince(projectDir: string, base: string | undefined, head: string): Promise<string[] | undefined> {
  if (base === undefined) return undefined;
  return withSafeGit(projectDir, async (_git, run) => {
    if ((await run(['merge-base', '--is-ancestor', base, head])).code !== 0) return undefined;
    const listed = await run(['rev-list', `${base}..${head}`]);
    if (listed.code !== 0) return undefined;
    return listed.stdout.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => line.trim());
  });
}

/** The integration branch's head, or `undefined` when it is gone. */
export function integrationHead(projectDir: string, branch: string): Promise<string | undefined> {
  return branchHead(projectDir, branch);
}

/**
 * Puts the change from `from` to `to` on top of the integration branch as
 * one commit, and moves the branch only if its head is still `expected`.
 * When `from` is the branch's head (a build task that started there) the
 * result is `to`'s tree; otherwise `merge-tree` combines them, and a
 * conflict is refused. Returns the new commit.
 */
export async function landOnIntegration(
  projectDir: string,
  params: { branch: string; expected: string; from: string; to: string; message: string; project: string; id: string },
): Promise<string> {
  return withSafeGit(projectDir, async (git, run) => {
    const merged = await run(['merge-tree', '--write-tree', '--no-messages', '--merge-base', params.from, params.expected, params.to]);
    if (merged.code === 1) throw new BriefstackError('task.conflict', { project: params.project });
    if (merged.code !== 0) throw new Error(`git merge-tree failed: ${merged.stderr.trim().slice(0, 300)}`);
    const tree = merged.stdout.trim().split(/\r?\n/, 1)[0] ?? '';
    const current = (await git(['rev-parse', `${params.expected}^{tree}`])).trim();
    if (tree === current) throw new BriefstackError('task.noChanges', { id: params.id });
    const identity = await identityArgs(projectDir);
    const commit = (await git([...identity, 'commit-tree', '--no-gpg-sign', tree, '-p', params.expected], params.message)).trim();
    const moved = await run(['update-ref', `refs/heads/${params.branch}`, commit, params.expected]);
    if (moved.code !== 0) throw new BriefstackError('build.branchMoved', { branch: params.branch });
    return commit;
  });
}

/** Removes the integration branch if it is still at `expected` (any value when `expected` is undefined). Gone already is fine. */
export async function deleteIntegrationBranch(projectDir: string, branch: string, expected?: string): Promise<void> {
  await withSafeGit(projectDir, async (_git, run) => {
    const head = await branchHead(projectDir, branch);
    if (head === undefined) return;
    const result = await run(['update-ref', '-d', `refs/heads/${branch}`, expected ?? head]);
    if (result.code !== 0) throw new BriefstackError('build.branchMoved', { branch });
  });
}

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

/**
 * Whether any worktree of the project's repository (its own folder
 * included) has `branch` checked out. `update-ref` does not look: moving
 * or removing a branch a worktree has checked out would change or break
 * that folder (review of M1, minor; step 33). Unknown counts as checked out.
 */
export async function branchCheckedOut(projectDir: string, branch: string): Promise<boolean> {
  return withSafeGit(projectDir, async (_git, run) => {
    const listed = await run(['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) return true;
    return listed.stdout.split(/\r?\n/).some((line) => line.trim() === `branch refs/heads/${branch}`);
  });
}

/** Refuses with `build.branchCheckedOut` when a worktree has the integration branch checked out. */
async function refuseCheckedOut(projectDir: string, branch: string): Promise<void> {
  if (await branchCheckedOut(projectDir, branch)) throw new BriefstackError('build.branchCheckedOut', { branch });
}

/** Makes `refs/heads/<branch>` at `base`; refused when the branch already exists. */
export async function createIntegrationBranch(projectDir: string, branch: string, base: string): Promise<void> {
  await withSafeGit(projectDir, async (git, run) => {
    await git(['check-ref-format', '--branch', branch]);
    // A base that is not a commit is a failure of its own, not "the branch exists" (review of M1, minor; step 33).
    if ((await run(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).code !== 0) throw new Error(`The build's base ${base.slice(0, 12)} is not a commit of the project's repository.`);
    // An empty old value: the ref must not exist (whatever the repository's hash format).
    const result = await run(['update-ref', `refs/heads/${branch}`, base, '']);
    if (result.code !== 0) {
      if ((await branchHead(projectDir, branch)) !== undefined) throw new BriefstackError('build.branchExists', { branch });
      throw new Error(`git update-ref failed: ${result.stderr.trim().slice(0, 300)}`);
    }
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
    await refuseCheckedOut(projectDir, params.branch);
    const moved = await run(['update-ref', `refs/heads/${params.branch}`, commit, params.expected]);
    if (moved.code !== 0) throw new BriefstackError('build.branchMoved', { branch: params.branch });
    return commit;
  });
}

/** What joining a card onto the integration head gives (phase 11): the joined commit, a textual conflict, or nothing new. */
export type PreparedJoin = { kind: 'commit'; commit: string } | { kind: 'conflict'; files: string[] } | { kind: 'empty' };

/**
 * The join of a card that started at `from` onto the integration head
 * `onto` (BRIEF-phase-11 §2, 9; decisions.md, "Phase 11: H0", 2):
 * `merge-tree` of the card's change (`from` to `to`) onto `onto`, then the
 * joined commit with `commit-tree`, `onto` its one parent. Nothing moves:
 * the caller checks that commit and moves the branch onto it with
 * `moveIntegration`. A conflict gives the files `merge-tree` names.
 */
export async function prepareJoin(projectDir: string, params: { from: string; onto: string; to: string; message: string }): Promise<PreparedJoin> {
  return withSafeGit(projectDir, async (git, run) => {
    const merged = await run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base', params.from, params.onto, params.to]);
    const out = merged.stdout.split(/\r?\n/).map((line) => line.trim());
    if (merged.code === 1) return { kind: 'conflict', files: [...new Set(out.slice(1).filter((line) => line !== ''))].slice(0, 20) };
    if (merged.code !== 0) throw new Error(`git merge-tree failed: ${merged.stderr.trim().slice(0, 300)}`);
    const tree = out[0] ?? '';
    if (tree === (await git(['rev-parse', `${params.onto}^{tree}`])).trim()) return { kind: 'empty' };
    const identity = await identityArgs(projectDir);
    return { kind: 'commit', commit: (await git([...identity, 'commit-tree', '--no-gpg-sign', tree, '-p', params.onto], params.message)).trim() };
  });
}

/** Moves the integration branch onto `commit` only if its head is still `expected` (a compare and swap); `build.branchMoved` otherwise. */
export async function moveIntegration(projectDir: string, branch: string, commit: string, expected: string): Promise<void> {
  await withSafeGit(projectDir, async (_git, run) => {
    await refuseCheckedOut(projectDir, branch);
    const moved = await run(['update-ref', `refs/heads/${branch}`, commit, expected]);
    if (moved.code !== 0) throw new BriefstackError('build.branchMoved', { branch });
  });
}

/** Removes the integration branch if it is still at `expected` (any value when `expected` is undefined). Gone already is fine. */
export async function deleteIntegrationBranch(projectDir: string, branch: string, expected?: string): Promise<void> {
  await withSafeGit(projectDir, async (_git, run) => {
    const head = await branchHead(projectDir, branch);
    if (head === undefined) return;
    await refuseCheckedOut(projectDir, branch);
    const result = await run(['update-ref', '-d', `refs/heads/${branch}`, expected ?? head]);
    if (result.code !== 0) throw new BriefstackError('build.branchMoved', { branch });
  });
}

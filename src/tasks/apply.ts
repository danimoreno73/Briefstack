import { rename, stat, writeFile } from 'node:fs/promises';
import { BriefstackError } from '../errors.js';
import { gitCommit, identityArgs } from '../library/git.js';
import { noteRelativePath, toNative } from '../library/layout.js';
import { withLibraryLock } from '../library/lock.js';
import { appendDated, libraryExists, readTextIfExists } from '../library/notes.js';
import { redactSecretLines } from '../validate/secrets.js';
import { removeTaskWorktree, repoState, runGit, uncommittedPaths, withSafeGit } from './git.js';
import type { TaskStore } from './store.js';
import { isActiveTask, type TaskRecord } from './types.js';

/**
 * Approving, reverting and discarding a task (BRIEF-phase-7 §3.5; PLAN §1,
 * 5). Approving applies the task's branch as one commit on the project's
 * default branch, with no push: `git merge-tree --write-tree` computes the
 * result from the task's base, `commit-tree` makes one commit with one
 * parent, and `merge --ff-only` moves the branch and the files of the
 * user's clean folder together. Reverting is the same with the applied
 * commit's change the other way. Refused, with the reason, when the folder
 * is not clean, another branch is checked out, the change no longer
 * applies, or another task on the project runs. Hooks never run; the
 * user's own filters (LFS) apply in their folder, as git would.
 */

export interface ApplyDeps {
  store: TaskStore;
  libraryDir: string;
  now?: () => Date;
}

const firstLine = (text: string): string => redactSecretLines(text.trim().split(/\r?\n/, 1)[0] ?? '').trim();
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const short = (sha: string): string => sha.slice(0, 7);

/** The checks every move of the user's folder shares. */
async function assertFolderReady(task: TaskRecord, store: TaskStore): Promise<string> {
  const dir = task.projectDir;
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new BriefstackError('task.folderMissing', { project: task.project, dir });
  }
  const other = (await store.list()).find((item) => item.id !== task.id && item.project === task.project && isActiveTask(item.state));
  if (other !== undefined) throw new BriefstackError('task.projectBusy', { project: task.project, id: other.id });
  const repo = await repoState(dir);
  if (!repo.inRepo || !repo.isTop || repo.head === undefined) throw new BriefstackError('task.notGitRepo', { project: task.project });
  if (repo.branch !== task.baseBranch) throw new BriefstackError('task.notOnBranch', { project: task.project, branch: task.baseBranch, current: repo.branch ?? 'HEAD' });
  const dirty = await uncommittedPaths(dir);
  if (dirty.length > 0) throw new BriefstackError('task.dirtyFolder', { project: task.project, paths: dirty.slice(0, 20) });
  const drivers = await runGit(dir, ['config', '--name-only', '--get-regexp', '^merge\\..*\\.driver$']);
  if (drivers.code === 0 && drivers.stdout.trim() !== '') throw new BriefstackError('task.mergeDrivers', { project: task.project });
  return repo.head;
}

/**
 * Puts the change from `from` to `to` on top of the folder's branch as one
 * commit, and moves the branch and the files there. Returns the new commit.
 */
async function land(task: TaskRecord, from: string, to: string, message: string, branchHead: string): Promise<string> {
  const dir = task.projectDir;
  const commit = await withSafeGit(dir, async (git, run) => {
    const merged = await run(['merge-tree', '--write-tree', '--no-messages', '--merge-base', from, branchHead, to]);
    if (merged.code === 1) throw new BriefstackError('task.conflict', { project: task.project });
    if (merged.code !== 0) throw new Error(`git merge-tree failed: ${merged.stderr.trim().slice(0, 300)}`);
    const tree = merged.stdout.trim().split(/\r?\n/, 1)[0] ?? '';
    const current = (await git(['rev-parse', `${branchHead}^{tree}`])).trim();
    if (tree === current) throw new BriefstackError('task.noChanges', { id: task.id });
    const identity = await identityArgs(dir);
    return (await git([...identity, 'commit-tree', '--no-gpg-sign', tree, '-p', branchHead], message)).trim();
  });
  // Compare and swap: the folder must still be clean and on the same commit as when it was read.
  const again = await repoState(dir);
  if (again.head !== branchHead || again.branch !== task.baseBranch) throw new BriefstackError('task.conflict', { project: task.project });
  if ((await uncommittedPaths(dir)).length > 0) throw new BriefstackError('task.dirtyFolder', { project: task.project, paths: [] });
  await withSafeGit(dir, (git) => git(['merge', '--ff-only', '--quiet', '--no-verify', commit]), { keepFilters: true });
  return commit;
}

/** A dated line in the project's library note, through the library's queue. A missing library or note is skipped. */
export async function recordInNote(libraryDir: string, slug: string, line: string, now: Date): Promise<void> {
  if (!(await libraryExists(libraryDir))) return;
  const relative = noteRelativePath('projects', slug);
  await withLibraryLock(libraryDir, async () => {
    const file = toNative(libraryDir, relative);
    const text = await readTextIfExists(file);
    if (text === undefined) return;
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, appendDated(text, `- ${line}`, now), 'utf8');
    await rename(temp, file);
    await gitCommit(libraryDir, [relative], `library: task in projects/${slug}`);
  });
}

/** Approve: one commit on the default branch, the worktree and the branch removed, a line in the note. */
export async function applyTask(task: TaskRecord, deps: ApplyDeps): Promise<TaskRecord> {
  if (task.state !== 'proposal') throw new BriefstackError('task.wrongState', { id: task.id, state: task.state });
  const blocking = (task.validations ?? []).filter((item) => item.level === 'error');
  if (blocking.length > 0) throw new BriefstackError('task.blocked', { id: task.id, files: blocking.map((item) => item.file) });
  const branchHead = await assertFolderReady(task, deps.store);
  const taskHead = (await runGit(task.projectDir, ['rev-parse', '--verify', `refs/heads/${task.branch}^{commit}`])).stdout.trim();
  // What lands is the commit the validations (and any checks the user ran) read and the page showed; a branch moved since is refused.
  if (task.reviewed !== undefined && taskHead !== task.reviewed) throw new BriefstackError('task.branchChanged', { id: task.id });
  if (taskHead === '' || taskHead === task.baseCommit) throw new BriefstackError('task.noChanges', { id: task.id });
  const rounds = task.rounds.length;
  const message = `${clip(firstLine(task.description), 72)}\n\nApplied by briefstack from task ${task.id} (${rounds} round${rounds === 1 ? '' : 's'}).\n`;
  const commit = await land(task, task.baseCommit, taskHead, message, branchHead);
  const now = (deps.now ?? (() => new Date()))();
  await removeTaskWorktree(task.projectDir, deps.store.worktreeDir(task.id), task.branch).catch(() => undefined);
  await recordInNote(deps.libraryDir, task.project, `Task applied: ${clip(firstLine(task.description), 120)} (commit ${short(commit)}, task ${task.id}).`, now).catch(() => undefined);
  return { ...task, state: 'applied', applied: { commit, at: now.toISOString() } };
}

/** Revert: one commit that undoes the applied one, under the same rules. */
export async function revertTask(task: TaskRecord, deps: ApplyDeps): Promise<TaskRecord> {
  if (task.state !== 'applied' || task.applied === undefined) throw new BriefstackError('task.wrongState', { id: task.id, state: task.state });
  const branchHead = await assertFolderReady(task, deps.store);
  const applied = task.applied.commit;
  const parent = (await runGit(task.projectDir, ['rev-parse', '--verify', `${applied}^1`])).stdout.trim();
  if (parent === '') throw new BriefstackError('task.conflict', { project: task.project });
  const message = `Revert "${clip(firstLine(task.description), 60)}"\n\nReverted by briefstack: task ${task.id}, commit ${applied}.\n`;
  const commit = await land(task, applied, parent, message, branchHead);
  const now = (deps.now ?? (() => new Date()))();
  await recordInNote(deps.libraryDir, task.project, `Task reverted: ${clip(firstLine(task.description), 120)} (commit ${short(commit)}, task ${task.id}).`, now).catch(() => undefined);
  return { ...task, state: 'reverted', reverted: { commit, at: now.toISOString() } };
}

/** Discard: the branch and the worktree go; nothing reaches the project. */
export async function discardTask(task: TaskRecord, deps: Pick<ApplyDeps, 'store'>): Promise<TaskRecord> {
  if (!['proposal', 'failed', 'cancelled', 'interrupted'].includes(task.state)) throw new BriefstackError('task.wrongState', { id: task.id, state: task.state });
  await removeTaskWorktree(task.projectDir, deps.store.worktreeDir(task.id), task.branch);
  return { ...task, state: 'discarded' };
}

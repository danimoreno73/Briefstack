import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchCheckedOut, createIntegrationBranch, deleteIntegrationBranch, integrationHead, landOnIntegration } from '../../src/builds/git.js';
import { isBriefstackError } from '../../src/errors.js';
import { createTaskWorktree, removeTaskWorktree } from '../../src/tasks/git.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// The integration branch (BRIEF-phase-9 §3.3; decisions.md, "Phase 9: H0", 1):
// made, moved and removed with update-ref against the value last read, never
// checked out in the user's folder. Runs on Linux, Windows and macOS in CI.

useHermeticGit();

let world: TaskWorld;
let project: string;

beforeEach(async () => {
  world = await taskWorld('builds-git');
  project = await world.project('garden', { 'README.md': 'Garden.\n' });
});
afterEach(() => world.cleanup());

const BRANCH = 'briefstack/build-mabc12-0a0b';

/** What the user's folder shows: branch, head, status and files. */
async function folderState(dir: string): Promise<{ branch: string; head: string; status: string; files: string[] }> {
  return {
    branch: (await gitIn(dir, 'symbolic-ref', '--short', 'HEAD')).trim(),
    head: (await gitIn(dir, 'rev-parse', 'HEAD')).trim(),
    status: await gitIn(dir, 'status', '--porcelain=v1'),
    files: (await readdir(dir)).filter((name) => name !== '.git').sort(),
  };
}

/** A task's worktree from the integration head, with one file committed: what a build's round leaves. */
async function taskOn(base: string, n: number, files: Record<string, string>): Promise<{ worktree: string; branch: string; head: string }> {
  const worktree = path.join(world.dir, `work-${n}`);
  const branch = `briefstack/task-t${n}`;
  await createTaskWorktree(project, worktree, branch, base);
  await writeTree(worktree, files);
  const head = await commitAll(worktree, `round ${n}`);
  return { worktree, branch, head };
}

describe('the integration branch', () => {
  it('is made at the base, refuses a second one, and moves only with the head it was read at', async () => {
    const before = await folderState(project);
    await createIntegrationBranch(project, BRANCH, before.head);
    expect(await integrationHead(project, BRANCH)).toBe(before.head);
    await expect(createIntegrationBranch(project, BRANCH, before.head)).rejects.toSatisfy((error) => isBriefstackError(error) && error.code === 'build.branchExists');
    // A base that is not a commit is not reported as an existing branch (review of M1, minor; step 33).
    await expect(createIntegrationBranch(project, 'briefstack/build-mabc12-0a0c', 'c'.repeat(40))).rejects.toSatisfy((error) => !isBriefstackError(error) && String(error).includes('is not a commit'));
    expect(await integrationHead(project, 'briefstack/build-mabc12-0a0c')).toBeUndefined();

    const first = await taskOn(before.head, 1, { 'a.txt': 'A\n' });
    const commit = await landOnIntegration(project, { branch: BRANCH, expected: before.head, from: before.head, to: first.head, message: 'Task 1', project: 'garden', id: 't1' });
    expect(await integrationHead(project, BRANCH)).toBe(commit);
    expect((await gitIn(project, 'rev-parse', `${commit}^`)).trim()).toBe(before.head);
    expect((await gitIn(project, 'show', `${commit}:a.txt`)).trim()).toBe('A');

    // The user's folder: the same branch, head, status and files.
    expect(await folderState(project)).toEqual(before);

    // A head read before that move is refused, and the branch does not move.
    await expect(
      landOnIntegration(project, { branch: BRANCH, expected: before.head, from: before.head, to: first.head, message: 'again', project: 'garden', id: 't1' }),
    ).rejects.toSatisfy((error) => isBriefstackError(error) && error.code === 'build.branchMoved');
    expect(await integrationHead(project, BRANCH)).toBe(commit);
    await removeTaskWorktree(project, first.worktree, first.branch);
  });

  it('bases the next task on the applied ones, and combines a task that started before another was applied', async () => {
    const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    await createIntegrationBranch(project, BRANCH, base);
    const one = await taskOn(base, 1, { 'a.txt': 'A\n' });
    // Started at the same base, before the first was applied (a waiting task the user approves later).
    const late = await taskOn(base, 3, { 'c.txt': 'C\n' });
    const c1 = await landOnIntegration(project, { branch: BRANCH, expected: base, from: base, to: one.head, message: 'Task 1', project: 'garden', id: 't1' });

    // The next task starts at the integration head and sees the first one's file.
    const two = await taskOn(c1, 2, { 'b.txt': 'B\n' });
    expect(await readFile(path.join(two.worktree, 'a.txt'), 'utf8')).toBe('A\n');
    const c2 = await landOnIntegration(project, { branch: BRANCH, expected: c1, from: c1, to: two.head, message: 'Task 2', project: 'garden', id: 't2' });

    const c3 = await landOnIntegration(project, { branch: BRANCH, expected: c2, from: base, to: late.head, message: 'Task 3', project: 'garden', id: 't3' });
    const files = (await gitIn(project, 'ls-tree', '--name-only', c3)).trim().split('\n').sort();
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'c.txt', 'README.md']));
    expect((await gitIn(project, 'log', '--format=%s', `${base}..${c3}`)).trim().split('\n')).toEqual(['Task 3', 'Task 2', 'Task 1']);
    for (const task of [one, two, late]) await removeTaskWorktree(project, task.worktree, task.branch);
  });

  it('refuses a conflict and a change that adds nothing', async () => {
    const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    await createIntegrationBranch(project, BRANCH, base);
    const one = await taskOn(base, 1, { 'README.md': 'One.\n' });
    const other = await taskOn(base, 2, { 'README.md': 'Other.\n' });
    const c1 = await landOnIntegration(project, { branch: BRANCH, expected: base, from: base, to: one.head, message: 'Task 1', project: 'garden', id: 't1' });
    await expect(landOnIntegration(project, { branch: BRANCH, expected: c1, from: base, to: other.head, message: 'Task 2', project: 'garden', id: 't2' })).rejects.toSatisfy(
      (error) => isBriefstackError(error) && error.code === 'task.conflict',
    );
    await expect(landOnIntegration(project, { branch: BRANCH, expected: c1, from: base, to: one.head, message: 'Again', project: 'garden', id: 't1' })).rejects.toSatisfy(
      (error) => isBriefstackError(error) && error.code === 'task.noChanges',
    );
    expect(await integrationHead(project, BRANCH)).toBe(c1);
    for (const task of [one, other]) await removeTaskWorktree(project, task.worktree, task.branch);
  });

  it('is never moved or removed while a worktree has it checked out (review of M1, minor; step 33)', async () => {
    const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    await createIntegrationBranch(project, BRANCH, base);
    const one = await taskOn(base, 1, { 'NOTES.md': 'Notes.\n' });
    const other = path.join(world.dir, 'by-hand');
    await gitIn(project, 'worktree', 'add', '--quiet', other, BRANCH);
    expect(await branchCheckedOut(project, BRANCH)).toBe(true);
    const checkedOut = (error: unknown) => isBriefstackError(error) && error.code === 'build.branchCheckedOut';
    await expect(landOnIntegration(project, { branch: BRANCH, expected: base, from: base, to: one.head, message: 'Task 1', project: 'garden', id: 't1' })).rejects.toSatisfy(checkedOut);
    await expect(deleteIntegrationBranch(project, BRANCH)).rejects.toSatisfy(checkedOut);
    expect(await integrationHead(project, BRANCH)).toBe(base);
    await gitIn(project, 'worktree', 'remove', '--force', other);
    expect(await branchCheckedOut(project, BRANCH)).toBe(false);
    const landed = await landOnIntegration(project, { branch: BRANCH, expected: base, from: base, to: one.head, message: 'Task 1', project: 'garden', id: 't1' });
    expect(await integrationHead(project, BRANCH)).toBe(landed);
    await removeTaskWorktree(project, one.worktree, one.branch);
  });

  it('is removed only at the head it was read at; gone already is fine', async () => {
    const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    await createIntegrationBranch(project, BRANCH, base);
    await expect(deleteIntegrationBranch(project, BRANCH, 'b'.repeat(40))).rejects.toSatisfy((error) => isBriefstackError(error) && error.code === 'build.branchMoved');
    await deleteIntegrationBranch(project, BRANCH, base);
    expect(await integrationHead(project, BRANCH)).toBeUndefined();
    await deleteIntegrationBranch(project, BRANCH);
    expect((await folderState(project)).head).toBe(base);
  });
});

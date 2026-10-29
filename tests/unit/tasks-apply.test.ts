import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTask, discardTask, revertTask } from '../../src/tasks/apply.js';
import { commitRound, createTaskWorktree } from '../../src/tasks/git.js';
import { proposalDiff } from '../../src/tasks/proposal.js';
import { branchOf, type TaskRecord } from '../../src/tasks/types.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

useHermeticGit();

let world: TaskWorld;
let project: string;

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  world = await taskWorld('tasks-apply');
  project = await world.project('garden', { 'src/app.txt': 'one\ntwo\nthree\n', 'README.md': '# Garden\n' });
  await world.initLibrary();
});

afterEach(() => world.cleanup());

/** A task in `proposal` whose branch changes `src/app.txt` and adds `CHANGES.md`. */
async function proposal(id = 'mvt001-0a0a', files: Record<string, string> = { 'src/app.txt': 'one\nTWO\nthree\n', 'CHANGES.md': 'Changed two.\n' }): Promise<TaskRecord> {
  const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
  const worktree = world.store.worktreeDir(id);
  await createTaskWorktree(project, worktree, branchOf(id), base);
  await writeTree(worktree, files);
  await commitRound(worktree, `briefstack task ${id}, round 1`);
  const record: TaskRecord = {
    v: 1,
    id,
    project: 'garden',
    projectDir: project,
    description: 'Make two loud.\nMore detail here.',
    profile: 'saver',
    model: 'sonnet',
    effort: 'low',
    state: 'proposal',
    baseBranch: 'main',
    baseCommit: base,
    branch: branchOf(id),
    hidden: [],
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
    rounds: [{ n: 1, text: 'Make two loud.', startedAt: '2026-10-29T10:00:00.000Z', outcome: 'completed' }],
    checks: [],
    validations: [],
  };
  await world.store.save(record);
  return record;
}

const deps = () => ({ store: world.store, libraryDir: world.library, now: () => new Date('2026-10-29T12:00:00Z') });

describe('the proposal diff', () => {
  it('lists each changed file with its hunks', async () => {
    const task = await proposal();
    const diff = await proposalDiff(project, task.baseCommit, task.branch);
    expect(diff.more).toBe(0);
    expect(diff.files.map((file) => [file.path, file.status, file.added, file.removed, file.shown])).toEqual([
      ['CHANGES.md', 'added', 1, 0, true],
      ['src/app.txt', 'modified', 1, 1, true],
    ]);
    expect(diff.files[1]?.hunks[0]?.lines).toContainEqual({ op: '+', text: 'TWO' });
  });
});

describe('approve', () => {
  it('applies the branch as one commit on the default branch, removes the worktree and branch, and notes it', async () => {
    const task = await proposal();
    const before = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    const applied = await applyTask(task, deps());
    expect(applied.state).toBe('applied');
    const head = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    expect(applied.applied).toEqual({ commit: head, at: '2026-10-29T12:00:00.000Z' });
    expect((await gitIn(project, 'rev-parse', 'HEAD^')).trim()).toBe(before);
    expect((await gitIn(project, 'log', '-1', '--format=%B')).trim()).toBe(`Make two loud.\n\nApplied by briefstack from task ${task.id} (1 round).`);
    expect(await readFile(path.join(project, 'src', 'app.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
    expect((await gitIn(project, 'status', '--porcelain')).trim()).toBe('');
    expect((await gitIn(project, 'branch', '--list', 'briefstack/*')).trim()).toBe('');
    expect(await exists(world.store.worktreeDir(task.id))).toBe(false);
    const note = await readFile(path.join(world.library, 'projects', 'garden.md'), 'utf8');
    expect(note).toContain('### 2026-10-29');
    expect(note).toContain(`- Task applied: Make two loud. (commit ${head.slice(0, 7)}, task ${task.id}).`);
    expect((await gitIn(world.library, 'log', '-1', '--format=%s')).trim()).toBe('library: task in projects/garden');
  });

  it('still applies when the default branch moved with an unrelated change', async () => {
    const task = await proposal();
    await writeTree(project, { 'README.md': '# Garden, moved\n' });
    const moved = await commitAll(project, 'unrelated');
    await applyTask(task, deps());
    expect((await gitIn(project, 'rev-parse', 'HEAD^')).trim()).toBe(moved);
    expect(await readFile(path.join(project, 'README.md'), 'utf8')).toBe('# Garden, moved\n');
    expect(await readFile(path.join(project, 'src', 'app.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('refuses a change that no longer applies, and leaves the folder as it was', async () => {
    const task = await proposal();
    await writeTree(project, { 'src/app.txt': 'one\nquiet two\nthree\n' });
    const moved = await commitAll(project, 'conflicting');
    await expect(applyTask(task, deps())).rejects.toMatchObject({ code: 'task.conflict' });
    expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(moved);
    expect((await gitIn(project, 'status', '--porcelain')).trim()).toBe('');
    expect(await exists(world.store.worktreeDir(task.id))).toBe(true);
  });

  it('refuses a folder with uncommitted or untracked changes, another branch, blocking validations, and another running task', async () => {
    const task = await proposal();
    await writeFile(path.join(project, 'draft.txt'), 'x\n', 'utf8');
    await expect(applyTask(task, deps())).rejects.toMatchObject({ code: 'task.dirtyFolder', params: { paths: ['draft.txt'] } });
    await gitIn(project, 'add', 'draft.txt');
    await expect(applyTask(task, deps())).rejects.toMatchObject({ code: 'task.dirtyFolder' });
    await gitIn(project, 'rm', '--cached', '--quiet', 'draft.txt');
    await writeFile(path.join(project, '.git', 'info', 'exclude'), 'draft.txt\n', 'utf8');

    await gitIn(project, 'checkout', '--quiet', '-b', 'dev');
    await expect(applyTask(task, deps())).rejects.toMatchObject({ code: 'task.notOnBranch', params: { branch: 'main', current: 'dev' } });
    await gitIn(project, 'checkout', '--quiet', 'main');

    await expect(applyTask({ ...task, validations: [{ kind: 'settingsOrHooks', level: 'error', file: '.mcp.json' }] }, deps())).rejects.toMatchObject({ code: 'task.blocked' });
    await expect(applyTask({ ...task, state: 'running' }, deps())).rejects.toMatchObject({ code: 'task.wrongState' });

    await world.store.save({ ...task, id: 'mvt002-0b0b', branch: branchOf('mvt002-0b0b'), state: 'running' });
    await expect(applyTask(task, deps())).rejects.toMatchObject({ code: 'task.projectBusy', params: { id: 'mvt002-0b0b' } });
  });

  it('runs none of the project\'s git hooks while applying', async () => {
    const task = await proposal();
    const mark = path.join(world.dir, 'hook-ran.txt');
    for (const name of ['post-merge', 'post-checkout', 'pre-commit', 'reference-transaction']) {
      const hook = path.join(project, '.git', 'hooks', name);
      await writeFile(hook, `#!/bin/sh\necho ${name} >> "${mark.split(path.sep).join('/')}"\n`, 'utf8');
      await chmod(hook, 0o755);
    }
    await applyTask(task, deps());
    expect(await exists(mark)).toBe(false);
  });
});

describe('revert and discard', () => {
  it('reverts an applied task with one commit, and notes it', async () => {
    const task = await proposal();
    const applied = await applyTask(task, deps());
    const reverted = await revertTask(applied, deps());
    expect(reverted.state).toBe('reverted');
    expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(reverted.reverted?.commit);
    expect((await gitIn(project, 'rev-parse', 'HEAD^')).trim()).toBe(applied.applied?.commit);
    expect(await readFile(path.join(project, 'src', 'app.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(await exists(path.join(project, 'CHANGES.md'))).toBe(false);
    expect((await gitIn(project, 'log', '-1', '--format=%s')).trim()).toBe('Revert "Make two loud."');
    expect(await readFile(path.join(world.library, 'projects', 'garden.md'), 'utf8')).toContain('- Task reverted: Make two loud.');
    await expect(revertTask(reverted, deps())).rejects.toMatchObject({ code: 'task.wrongState' });
  });

  it('refuses to revert into a dirty folder', async () => {
    const applied = await applyTask(await proposal(), deps());
    await writeFile(path.join(project, 'README.md'), '# Edited\n', 'utf8');
    await expect(revertTask(applied, deps())).rejects.toMatchObject({ code: 'task.dirtyFolder' });
  });

  it('discards: the branch and the worktree go, the project is untouched', async () => {
    const task = await proposal();
    const head = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    expect((await discardTask(task, deps())).state).toBe('discarded');
    expect(await exists(world.store.worktreeDir(task.id))).toBe(false);
    expect((await gitIn(project, 'branch', '--list', 'briefstack/*')).trim()).toBe('');
    expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(head);
    await expect(discardTask({ ...task, state: 'applied' }, deps())).rejects.toMatchObject({ code: 'task.wrongState' });
  });
});

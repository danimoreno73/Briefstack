import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeProjectNote, type ProjectStatus } from '../../src/library/projectStatus.js';
import { INIT_COMMIT_MESSAGE } from '../../src/tasks/git.js';
import { checkTaskPreconditions, initProjectRepo, type PreconditionContext } from '../../src/tasks/preconditions.js';
import { TaskStore, newTaskId } from '../../src/tasks/store.js';
import type { TaskRecord, TaskState } from '../../src/tasks/types.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

const run = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', args, { cwd, windowsHide: true })).stdout;

let dir: string;
let library: string;
let project: string;
let cleanup: () => Promise<void>;
let tasks: TaskRecord[];
let creationOn: string | undefined;
let active: { count: number; limit: number; ids: string[] };

const status = (overrides: Partial<ProjectStatus> = {}): ProjectStatus => ({
  statusFormat: 1,
  slug: 'garden',
  target: 'claude-code',
  path: project,
  status: 'created',
  profile: 'balanced',
  updated: '2026-10-29',
  summary: 'A garden planner.',
  ...overrides,
});

const writeNote = (overrides: Partial<ProjectStatus> = {}) =>
  writeTree(library, { 'projects/garden.md': writeProjectNote(status(overrides), '# Garden planner\n\nText.\n') });

const ctx = (): PreconditionContext => ({
  libraryDir: library,
  repoDir: path.join(dir, 'repo'),
  tasks: async () => tasks,
  creationOn: () => creationOn,
  active: async () => active,
});

const record = (state: TaskState, project = 'garden'): TaskRecord => ({
  v: 1,
  id: newTaskId(),
  project,
  projectDir: '/x',
  description: 'Do it.',
  profile: 'balanced',
  model: 'sonnet',
  effort: 'medium',
  state,
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
  branch: 'briefstack/task-x',
  hidden: [],
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  rounds: [],
});

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-pre'));
  library = path.join(dir, 'library');
  project = path.join(dir, 'projects', 'garden');
  tasks = [];
  creationOn = undefined;
  active = { count: 0, limit: 2, ids: [] };
  await writeTree(project, { 'CLAUDE.md': '# Garden\n', '.briefstack/profile.json': '{}\n' });
  await gitIn(project, 'init', '--quiet', '-b', 'main');
  await gitIn(project, 'add', '-A');
  await gitIn(project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'start');
  await writeNote();
});

afterEach(() => cleanup());

const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as { code: string; params: Record<string, unknown> });

describe('task preconditions', () => {
  it('passes for a registered claude-code project with a commit, and says what is uncommitted', async () => {
    const head = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    expect(await checkTaskPreconditions(ctx(), 'garden')).toEqual({ slug: 'garden', name: 'Garden planner', dir: project, branch: 'main', head, uncommitted: [] });
    await writeFile(path.join(project, 'notes.txt'), 'draft\n', 'utf8');
    expect((await checkTaskPreconditions(ctx(), 'garden')).uncommitted).toEqual(['notes.txt']);
  });

  it('refuses a project the library does not have, or with a bad slug', async () => {
    expect(await refusal(checkTaskPreconditions(ctx(), 'orchard'))).toMatchObject({ code: 'task.projectNotFound' });
    expect(await refusal(checkTaskPreconditions(ctx(), '../garden'))).toMatchObject({ code: 'task.projectNotFound' });
  });

  it('refuses a claude-app project and an archived one', async () => {
    await writeNote({ target: 'claude-app' });
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.notClaudeCode', params: { target: 'claude-app' } });
    await writeNote({ archived: '2026-10-28' });
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.archived' });
  });

  it('refuses a missing folder, one briefstack did not create, and one over briefstack\'s own folders', async () => {
    await writeNote({ path: path.join(dir, 'nowhere') });
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.folderMissing' });
    await writeNote();
    await rm(path.join(project, '.briefstack'), { recursive: true });
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.notFromBriefstack' });
    await writeNote({ path: dir });
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.folderProtected' });
  });

  it('refuses a folder that is not a repository, one inside another, one without a commit and a detached HEAD', async () => {
    await rm(path.join(project, '.git'), { recursive: true, force: true });
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.notGitRepo' });

    await gitIn(project, 'init', '--quiet', '-b', 'main');
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.noCommit' });

    await rm(path.join(project, '.git'), { recursive: true, force: true });
    await gitIn(path.join(dir, 'projects'), 'init', '--quiet');
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.insideOtherRepo' });
    await rm(path.join(dir, 'projects', '.git'), { recursive: true, force: true });

    await gitIn(project, 'init', '--quiet', '-b', 'main');
    await gitIn(project, 'add', '-A');
    await gitIn(project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'start');
    await gitIn(project, 'checkout', '--quiet', '--detach');
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.detachedHead' });
  });

  it('refuses a second open task on the project, but not one on another project or a closed one', async () => {
    tasks = [record('applied'), record('discarded'), record('running', 'orchard')];
    await expect(checkTaskPreconditions(ctx(), 'garden')).resolves.toBeDefined();
    for (const state of ['running', 'checking', 'proposal', 'failed', 'cancelled', 'interrupted'] as const) {
      const open = record(state);
      tasks = [open];
      expect(await refusal(checkTaskPreconditions(ctx(), 'garden')), state).toMatchObject({ code: 'task.projectBusy', params: { id: open.id } });
    }
  });

  it('refuses while a creation targets the folder, and at the shared limit', async () => {
    creationOn = 'A garden';
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.creationOnFolder', params: { holder: 'A garden' } });
    creationOn = undefined;
    active = { count: 2, limit: 2, ids: ['c1', 't1'] };
    expect(await refusal(checkTaskPreconditions(ctx(), 'garden'))).toMatchObject({ code: 'task.limit', params: { limit: 2, active: ['c1', 't1'] } });
  });

  it('initialises a folder that is not a repository with one commit, and refuses one that is', async () => {
    expect(await refusal(initProjectRepo(ctx(), 'garden'))).toMatchObject({ code: 'task.alreadyRepo' });
    await rm(path.join(project, '.git'), { recursive: true, force: true });
    const { commit } = await initProjectRepo(ctx(), 'garden');
    expect((await gitIn(project, 'log', '--format=%H %s')).trim()).toBe(`${commit} ${INIT_COMMIT_MESSAGE}`);
    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Garden\n');
    await expect(checkTaskPreconditions(ctx(), 'garden')).resolves.toMatchObject({ head: commit });
  });
});

describe('task store', () => {
  it('saves a record aside and renames it, reads it back, and lists newest first', async () => {
    const store = new TaskStore(path.join(dir, 'home', 'tasks'));
    const older = { ...record('applied'), createdAt: '2026-10-28T10:00:00.000Z' };
    const newer = record('running');
    await store.save(older);
    await store.save(newer);
    expect(await store.load(newer.id)).toEqual(newer);
    expect((await store.list()).map((task) => task.id)).toEqual([newer.id, older.id]);
    expect(store.worktreeDir(newer.id)).toBe(path.join(dir, 'home', 'tasks', newer.id, 'work'));
    expect(await store.load('../x')).toBeUndefined();
    expect(() => store.taskDir('../x')).toThrow();
    await writeFile(path.join(dir, 'home', 'tasks', older.id, 'task.json'), '{ broken', 'utf8');
    expect((await store.list()).map((task) => task.id)).toEqual([newer.id]);
  });
});

import { execFile } from 'node:child_process';
import { chmod, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTaskWorktree,
  gitIsRecentEnough,
  gitVersion,
  initRepoWithCommit,
  INIT_COMMIT_MESSAGE,
  removeTaskWorktree,
  repoState,
  uncommittedPaths,
} from '../../src/tasks/git.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

const run = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', args, { cwd, windowsHide: true })).stdout;
const commitAll = async (cwd: string, message: string): Promise<void> => {
  await gitIn(cwd, 'add', '-A');
  await gitIn(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '--no-verify', '-m', message);
};
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

let dir: string;
let project: string;
let cleanup: () => Promise<void>;

/** A hook script that leaves a file behind when it runs: none of the server's git commands may run it. */
const MARK_HOOK = (mark: string) => `#!/bin/sh\necho ran > "${mark.split(path.sep).join('/')}"\n`;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-git'));
  project = path.join(dir, 'project');
  await writeTree(project, {
    'CLAUDE.md': '# Project\n',
    '.claude/settings.json': '{ "hooks": {} }\n',
    '.claude/agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\n\nHelp.\n',
    '.briefstack/profile.json': '{}\n',
    '.gitignore': 'node_modules/\n',
    'src/app.txt': 'one\n',
  });
  await gitIn(project, 'init', '--quiet', '-b', 'main');
  await gitIn(project, 'config', 'core.autocrlf', 'false');
  await commitAll(project, 'start');
});

afterEach(() => cleanup());

describe('git for tasks', () => {
  it('finds a git recent enough for merge-tree --write-tree', async () => {
    const version = await gitVersion();
    expect(version).toBeDefined();
    expect(gitIsRecentEnough(version!)).toBe(true);
    expect(gitIsRecentEnough({ major: 2, minor: 37, text: '2.37' })).toBe(false);
    expect(gitIsRecentEnough({ major: 2, minor: 38, text: '2.38' })).toBe(true);
    expect(gitIsRecentEnough({ major: 3, minor: 0, text: '3.0' })).toBe(true);
  });

  it('tells a repository top, a subfolder, a folder outside git, an unborn branch and a detached HEAD apart', async () => {
    expect(await repoState(project)).toMatchObject({ inRepo: true, isTop: true, branch: 'main', head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(await repoState(path.join(project, 'src'))).toMatchObject({ inRepo: true, isTop: false });

    const outside = path.join(dir, 'outside');
    await writeTree(outside, { 'a.txt': 'a\n' });
    expect(await repoState(outside)).toEqual({ inRepo: false, isTop: false });

    const unborn = path.join(dir, 'unborn');
    await writeTree(unborn, { 'a.txt': 'a\n' });
    await gitIn(unborn, 'init', '--quiet', '-b', 'trunk');
    const state = await repoState(unborn);
    expect(state).toMatchObject({ inRepo: true, isTop: true, branch: 'trunk' });
    expect(state.head).toBeUndefined();

    await gitIn(project, 'checkout', '--quiet', '--detach');
    const detached = await repoState(project);
    expect(detached.head).toBeDefined();
    expect(detached.branch).toBeUndefined();
  });

  it('lists uncommitted paths, untracked ones included, and nothing ignored', async () => {
    expect(await uncommittedPaths(project)).toEqual([]);
    await writeTree(project, { 'src/app.txt': 'two\n', 'new.txt': 'n\n', 'node_modules/x/index.js': 'x\n' });
    expect((await uncommittedPaths(project)).sort()).toEqual(['new.txt', 'src/app.txt']);
  });

  it('creates the worktree outside the project with the settings file hidden, and removes it with its branch', async () => {
    const worktree = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'work');
    const head = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    const created = await createTaskWorktree(project, worktree, 'briefstack/task-abc123-0f0f', head);

    expect(created.hidden).toEqual(['.claude/settings.json']);
    expect(await exists(path.join(worktree, '.claude', 'settings.json'))).toBe(false);
    expect(await readFile(path.join(worktree, 'CLAUDE.md'), 'utf8')).toBe('# Project\n');
    expect(await exists(path.join(worktree, '.claude', 'agents', 'helper.md'))).toBe(true);
    // The worktree is clean, and adding everything does not stage the hidden file's deletion.
    expect((await gitIn(worktree, 'status', '--porcelain')).trim()).toBe('');
    await gitIn(worktree, 'add', '-A');
    expect((await gitIn(worktree, 'diff', '--cached', '--name-only')).trim()).toBe('');
    // The project folder keeps its file, its branch and a clean status.
    expect(await readFile(path.join(project, '.claude', 'settings.json'), 'utf8')).toBe('{ "hooks": {} }\n');
    expect((await gitIn(project, 'status', '--porcelain')).trim()).toBe('');
    expect((await gitIn(project, 'symbolic-ref', '--short', 'HEAD')).trim()).toBe('main');
    expect((await gitIn(project, 'branch', '--list', 'briefstack/task-abc123-0f0f')).trim()).toContain('briefstack/task-abc123-0f0f');

    await removeTaskWorktree(project, worktree, 'briefstack/task-abc123-0f0f');
    expect(await exists(worktree)).toBe(false);
    expect((await gitIn(project, 'branch', '--list', 'briefstack/task-*')).trim()).toBe('');
    expect((await gitIn(project, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree ')).length).toBe(1);
    // Removing again is fine.
    await removeTaskWorktree(project, worktree, 'briefstack/task-abc123-0f0f');
  });

  it('runs none of the project\'s hooks or filter drivers', async () => {
    const mark = path.join(dir, 'ran.txt');
    const filterMark = path.join(dir, 'filter.txt');
    await writeTree(project, { '.git/hooks/post-checkout': MARK_HOOK(mark), '.gitattributes': '*.txt filter=probe\n' });
    await chmod(path.join(project, '.git', 'hooks', 'post-checkout'), 0o755);
    await commitAll(project, 'attributes');
    await gitIn(project, 'config', 'filter.probe.smudge', `sh -c 'echo ran > "${filterMark.split(path.sep).join('/')}"; cat'`);
    await gitIn(project, 'config', 'filter.probe.required', 'true');
    const worktree = path.join(dir, 'home', 'tasks', 'abc123-1f1f', 'work');
    const head = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
    await createTaskWorktree(project, worktree, 'briefstack/task-abc123-1f1f', head);
    await removeTaskWorktree(project, worktree, 'briefstack/task-abc123-1f1f');
    expect(await exists(mark)).toBe(false);
    expect(await exists(filterMark)).toBe(false);
    // Control: a plain worktree add runs both, so the check above means something.
    await gitIn(project, 'worktree', 'add', '--quiet', '-b', 'control', path.join(dir, 'control'), head);
    expect(await exists(mark)).toBe(true);
    expect(await exists(filterMark)).toBe(true);
  });

  it('makes a folder a repository with one commit of its files, respecting .gitignore', async () => {
    const plain = path.join(dir, 'plain');
    await writeTree(plain, { 'a.txt': 'a\n', '.gitignore': 'secret.env\n', 'secret.env': 'X=1\n' });
    const commit = await initRepoWithCommit(plain);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await gitIn(plain, 'log', '--format=%s')).trim()).toBe(INIT_COMMIT_MESSAGE);
    expect((await gitIn(plain, 'ls-files')).trim().split('\n').sort()).toEqual(['.gitignore', 'a.txt']);
    expect((await gitIn(plain, 'status', '--porcelain')).trim()).toBe('');
  });
});

describe('long paths', () => {
  it.runIf(process.platform === 'win32')('keeps a path over 260 characters in the worktree', async () => {
    const deep = ['d'.repeat(60), 'e'.repeat(60), 'f'.repeat(60), 'g'.repeat(60), 'h.txt'].join('/');
    await gitIn(project, 'config', 'core.longpaths', 'true');
    await writeTree(project, { [deep]: 'deep\n' });
    await commitAll(project, 'deep');
    await gitIn(project, 'config', '--unset', 'core.longpaths');
    const worktree = path.join(dir, 'home', 'tasks', 'abc123-2f2f', 'work');
    await createTaskWorktree(project, worktree, 'briefstack/task-abc123-2f2f', 'HEAD');
    expect(await readFile(path.join(worktree, ...deep.split('/')), 'utf8')).toBe('deep\n');
    await removeTaskWorktree(project, worktree, 'briefstack/task-abc123-2f2f');
    expect(await exists(worktree)).toBe(false);
  });
});

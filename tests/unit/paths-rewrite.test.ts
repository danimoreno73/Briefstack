import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { rewritePathPrefix, type PathEnv } from '../../src/config/paths.js';
import { addNote, initLibrary, rewriteProjectNotePaths } from '../../src/library/index.js';
import { rewriteFolders } from '../../src/relocate.js';
import { newTaskId, tasksRoot, TaskStore } from '../../src/tasks/store.js';
import type { TaskRecord, TaskState } from '../../src/tasks/types.js';
import { tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

const win: PathEnv = { env: {}, homedir: 'C:\\Users\\ana', pathApi: path.win32, caseInsensitive: true };
const linux: PathEnv = { env: {}, homedir: '/home/ana', pathApi: path.posix, caseInsensitive: false };
const mac: PathEnv = { env: {}, homedir: '/Users/ana', pathApi: path.posix, caseInsensitive: true };

describe('rewritePathPrefix', () => {
  const from = 'D:\\Dani\\briefstack-projects';
  const to = 'D:\\Dani\\briefstack\\proyectos';

  it('moves a Windows path written with \\ or with /, keeping how it was written', () => {
    expect(rewritePathPrefix('D:\\Dani\\briefstack-projects\\todo-cli', from, to, win)).toBe('D:\\Dani\\briefstack\\proyectos\\todo-cli');
    expect(rewritePathPrefix('D:/Dani/briefstack-projects/todo-cli', from, to, win)).toBe('D:/Dani/briefstack/proyectos/todo-cli');
    expect(rewritePathPrefix('D:/Dani/briefstack-projects/a/b', 'D:/Dani/briefstack-projects/', 'D:/Dani/briefstack/proyectos', win)).toBe('D:/Dani/briefstack/proyectos/a/b');
    expect(rewritePathPrefix('D:\\Dani\\briefstack-projects', from, to, win)).toBe(to);
    expect(rewritePathPrefix('D:\\Dani\\briefstack-projects\\', from, to, win)).toBe(to);
  });

  it('matches Windows paths in any case and keeps the case of the rest', () => {
    expect(rewritePathPrefix('d:\\dani\\BRIEFSTACK-Projects\\Todo-CLI', from, to, win)).toBe('D:\\Dani\\briefstack\\proyectos\\Todo-CLI');
    expect(rewritePathPrefix('d:/DANI/briefstack-projects/x', from, to, win)).toBe('D:/Dani/briefstack/proyectos/x');
  });

  it('leaves alone a folder that only starts with the same letters', () => {
    expect(rewritePathPrefix('D:\\Dani\\briefstack-projects-old\\todo-cli', from, to, win)).toBeUndefined();
    expect(rewritePathPrefix('D:/Dani/briefstack-projects-old', from, to, win)).toBeUndefined();
    expect(rewritePathPrefix('D:\\Dani\\briefstack-projectsX', from, to, win)).toBeUndefined();
    expect(rewritePathPrefix('D:\\Dani', from, to, win)).toBeUndefined();
    expect(rewritePathPrefix('/home/ana/projects-old/x', '/home/ana/projects', '/srv/p', linux)).toBeUndefined();
  });

  it('leaves alone relative paths, Windows paths without a drive and other drives', () => {
    expect(rewritePathPrefix('briefstack-projects/todo-cli', from, to, win)).toBeUndefined();
    expect(rewritePathPrefix('\\Dani\\briefstack-projects\\x', from, to, win)).toBeUndefined();
    expect(rewritePathPrefix('E:\\Dani\\briefstack-projects\\x', from, to, win)).toBeUndefined();
  });

  it('expands ~ in the value', () => {
    expect(rewritePathPrefix('~/briefstack-projects/x', 'C:\\Users\\ana\\briefstack-projects', to, win)).toBe('D:/Dani/briefstack/proyectos/x');
    expect(rewritePathPrefix('~/projects/x', '/home/ana/projects', '/srv/p', linux)).toBe('/srv/p/x');
  });

  it('compares case only where the system does: not on Linux, yes on macOS', () => {
    expect(rewritePathPrefix('/home/ana/projects/x', '/home/ana/projects', '/srv/p', linux)).toBe('/srv/p/x');
    expect(rewritePathPrefix('/home/ana/Projects/x', '/home/ana/projects', '/srv/p', linux)).toBeUndefined();
    expect(rewritePathPrefix('/Users/ana/PROJECTS/Garden', '/Users/ana/projects', '/Volumes/d/p', mac)).toBe('/Volumes/d/p/Garden');
  });
});

describe('rewriteFolders', () => {
  it('refuses the same folder, nested folders and relative paths', () => {
    expect(() => rewriteFolders('D:\\Dani\\briefstack', 'd:/dani/BRIEFSTACK', win)).toThrow(expect.objectContaining({ code: 'paths.overlapping' }));
    expect(() => rewriteFolders('D:\\Dani\\briefstack', 'D:\\Dani\\briefstack\\repo', win)).toThrow(expect.objectContaining({ code: 'paths.overlapping' }));
    expect(() => rewriteFolders('D:\\Dani\\briefstack\\repo', 'D:\\Dani\\briefstack', win)).toThrow(expect.objectContaining({ code: 'paths.overlapping' }));
    expect(() => rewriteFolders('briefstack-projects', 'D:\\x', win)).toThrow(expect.objectContaining({ code: 'config.relativePath', params: { source: '--from', value: 'briefstack-projects' } }));
    expect(() => rewriteFolders('D:\\x', '/x', win)).toThrow(expect.objectContaining({ code: 'config.relativePath', params: { source: '--to', value: '/x' } }));
    expect(rewriteFolders('D:\\Dani\\briefstack-projects', 'D:/Dani/briefstack/proyectos/', win)).toEqual({ from: 'D:\\Dani\\briefstack-projects', to: 'D:\\Dani\\briefstack\\proyectos' });
    expect(rewriteFolders('/home/ana/projects', '/home/ana/projects-old', linux)).toEqual({ from: '/home/ana/projects', to: '/home/ana/projects-old' });
  });
});

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const slash = (value: string): string => value.replace(/\\/g, '/');

const taskRecord = (projectDir: string, state: TaskState): TaskRecord => ({
  v: 1,
  id: newTaskId(),
  project: 'garden',
  projectDir,
  description: 'Do it.',
  profile: 'balanced',
  model: 'sonnet',
  effort: 'medium',
  state,
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
  branch: 'briefstack/task-x',
  hidden: [],
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
  rounds: [],
});

const projectNote = (dir: string): string =>
  `---\ntarget: claude-code\npath: ${dir}\nstatus: created\nprofile: saver\nsummary: A project.\n---\n# Project\n\nIt lives in ${dir}, and that line stays.\n`;

describe('cli: paths rewrite', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let libraryDir: string;
  let repoDir: string;
  let oldProjects: string;
  let lookalike: string;
  let newProjects: string;
  let store: TaskStore;

  const capture = (env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      cwd: dir,
      repoDir,
      pathEnv: { env: { BRIEFSTACK_HOME: home, BRIEFSTACK_LANG: 'en', ...env }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' },
    };
    return { io, out, err };
  };
  const readText = (file: string) => readFile(file, 'utf8');
  const commits = () => Number(git(libraryDir, ['rev-list', '--count', 'HEAD']).trim());

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('paths-rewrite'));
    home = path.join(dir, 'home');
    libraryDir = path.join(home, 'library');
    repoDir = path.join(dir, 'repo');
    oldProjects = path.join(dir, 'briefstack-projects');
    lookalike = path.join(dir, 'briefstack-projects-old');
    newProjects = path.join(dir, 'briefstack', 'proyectos');
    await mkdir(newProjects, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'config.json'), `${JSON.stringify({ projectsDir: oldProjects, lang: 'es' }, null, 2)}\n`, 'utf8');
    await initLibrary({ libraryDir, projectsDir: oldProjects, sessionsDir: path.join(home, 'sessions'), repoDir });
    await addNote({ libraryDir, section: 'projects', name: 'garden', text: projectNote(`${slash(oldProjects)}/garden`) });
    await addNote({ libraryDir, section: 'projects', name: 'kept', text: projectNote(path.join(lookalike, 'kept')) });
    store = new TaskStore(tasksRoot(home));
  });
  afterEach(() => cleanup());

  it('a dry run lists every file and change and writes nothing', async () => {
    const task = taskRecord(path.join(oldProjects, 'garden'), 'applied');
    await store.save(task);
    const before = { config: await readText(path.join(home, 'config.json')), settings: await readText(path.join(repoDir, '.claude', 'settings.local.json')), commits: commits() };
    const run = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', newProjects], run.io)).toBe(0);
    const note = path.join(libraryDir, 'projects', 'garden.md');
    const settings = path.join(repoDir, '.claude', 'settings.local.json');
    expect(run.out).toEqual([
      'Dry run: nothing was written. Run it again with --apply to write these changes.',
      path.join(home, 'config.json'),
      `  projectsDir: ${oldProjects} -> ${newProjects}`,
      note,
      `  path: ${slash(oldProjects)}/garden -> ${slash(path.join(newProjects, 'garden'))}`,
      store.recordFile(task.id),
      `  projectDir: ${path.join(oldProjects, 'garden')} -> ${path.join(newProjects, 'garden')}`,
      settings,
      `  permissions.additionalDirectories: ${slash(oldProjects)} -> ${slash(newProjects)}`,
      '4 files would change.',
      'Records of what happened (session summaries, the creation log, chat threads, finished improvements) keep their old paths.',
    ]);
    expect(run.err).toEqual([]);
    expect(await readText(path.join(home, 'config.json'))).toBe(before.config);
    expect(await readText(settings)).toBe(before.settings);
    expect(commits()).toBe(before.commits);
    expect((await store.load(task.id))?.projectDir).toBe(path.join(oldProjects, 'garden'));
  });

  it('--apply writes them, commits the notes once, and a second run finds nothing', async () => {
    const task = taskRecord(path.join(oldProjects, 'garden'), 'applied');
    await store.save(task);
    const before = commits();
    const run = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', newProjects, '--apply'], run.io)).toBe(0);
    expect(run.out[0]).toBe('Written:');
    expect(run.out).toContain('4 files changed.');
    expect(run.out).toContain('The library notes were committed together, in one commit.');

    expect(JSON.parse(await readText(path.join(home, 'config.json')))).toEqual({ projectsDir: newProjects, lang: 'es' });
    const garden = await readText(path.join(libraryDir, 'projects', 'garden.md'));
    expect(garden).toContain(`path: ${slash(newProjects)}/garden\n`);
    // Only the status block: the body keeps what it said.
    expect(garden).toContain(`It lives in ${slash(oldProjects)}/garden, and that line stays.`);
    expect(await readText(path.join(libraryDir, 'projects', 'kept.md'))).toContain(path.join(lookalike, 'kept'));
    expect(commits()).toBe(before + 1);
    expect(git(libraryDir, ['log', '-1', '--format=%s']).trim()).toBe('library: project paths moved to their new folder (1)');
    expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
    expect((await store.load(task.id))?.projectDir).toBe(path.join(newProjects, 'garden'));
    const settings = JSON.parse(await readText(path.join(repoDir, '.claude', 'settings.local.json'))) as { permissions: { additionalDirectories: string[] } };
    expect(settings.permissions.additionalDirectories).toEqual([slash(newProjects), slash(path.join(home, 'sessions'))]);

    const again = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', newProjects, '--apply'], again.io)).toBe(0);
    expect(again.out[0]).toBe(`Nothing briefstack works with points inside ${oldProjects}; nothing to change.`);
    expect(commits()).toBe(before + 1);
  });

  it('--json reports the same, and open tasks are named', async () => {
    const open = taskRecord(path.join(oldProjects, 'garden'), 'proposal');
    await store.save(open);
    const run = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', newProjects, '--json'], run.io)).toBe(0);
    const report = JSON.parse(run.out.join('\n')) as { applied: boolean; files: string[]; changes: { field: string }[]; notices: { kind: string; id?: string }[] };
    expect(report.applied).toBe(false);
    expect(report.files).toHaveLength(4);
    expect(report.changes.map((change) => change.field)).toEqual(['projectsDir', 'path', 'projectDir', 'permissions.additionalDirectories']);
    expect(report.notices).toEqual([{ kind: 'openTask', id: open.id, project: 'garden', state: 'proposal' }]);
  });

  it('refuses --apply to a folder that does not exist, and a home still inside the old folder', async () => {
    const missing = path.join(dir, 'nowhere');
    const dry = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', missing], dry.io)).toBe(0);
    expect(dry.err).toEqual([`${missing} is not a folder yet: --apply refuses to write until it is.`]);
    const applied = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', missing, '--apply'], applied.io)).toBe(1);
    expect(applied.err.join('\n')).toContain(`${missing} is not a folder.`);
    expect(JSON.parse(await readText(path.join(home, 'config.json')))).toMatchObject({ projectsDir: oldProjects });

    const homeMoved = capture();
    expect(await main(['paths', 'rewrite', '--from', home, '--to', newProjects], homeMoved.io)).toBe(1);
    expect(homeMoved.err.join('\n')).toContain('BRIEFSTACK_HOME');
  });

  it('needs both folders', async () => {
    const run = capture();
    expect(await main(['paths', 'rewrite', '--from', oldProjects], run.io)).toBe(2);
    expect(await main(['paths', 'rewrite', '--from', oldProjects, '--to', newProjects, 'extra'], run.io)).toBe(2);
  });
});

describe('rewriteProjectNotePaths', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('note-paths'));
  });
  afterEach(() => cleanup());

  it('changes nothing in a note but its path, and commits nothing when no note matches', async () => {
    const libraryDir = path.join(dir, 'library');
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'p'), sessionsDir: path.join(dir, 's'), repoDir: path.join(dir, 'r') });
    const from = path.join(dir, 'old');
    await addNote({ libraryDir, section: 'projects', name: 'a', text: projectNote(path.join(from, 'a')) });
    const file = path.join(libraryDir, 'projects', 'a.md');
    const before = await readFile(file, 'utf8');
    const result = await rewriteProjectNotePaths({ libraryDir, from, to: path.join(dir, 'new'), pathEnv: { homedir: dir, pathApi: path, caseInsensitive: process.platform !== 'linux' }, apply: true });
    expect(result).toMatchObject({ committed: true, changes: [{ file: 'projects/a.md', before: path.join(from, 'a'), after: path.join(dir, 'new', 'a') }] });
    // The first mention is the status block's; the body keeps its own.
    expect(await readFile(file, 'utf8')).toBe(before.replace(path.join(from, 'a'), path.join(dir, 'new', 'a')));
    const none = await rewriteProjectNotePaths({ libraryDir, from: path.join(dir, 'elsewhere'), to: path.join(dir, 'new2'), pathEnv: { homedir: dir, pathApi: path, caseInsensitive: false }, apply: true });
    expect(none).toEqual({ changes: [], committed: false, warnings: [] });
  });
});

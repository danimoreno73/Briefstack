import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { specInput, tempDir, useHermeticGit, writeTree } from '../helpers.js';

const execFileAsync = promisify(execFile);

useHermeticGit();

interface Captured {
  io: CliIO;
  out: string[];
  err: string[];
}

function capture(dir: string, env: Record<string, string> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      cwd: dir,
      // Never the real repo: `init` writes <repoDir>/.claude/settings.local.json.
      repoDir: path.join(dir, 'repo'),
      pathEnv: {
        env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: 'en', ...env },
        homedir: path.join(dir, 'user'),
        pathApi: path,
        caseInsensitive: process.platform !== 'linux',
      },
    },
  };
}

describe('cli: init and library', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli-library'));
  });
  afterEach(() => cleanup());

  const libraryDir = () => path.join(dir, 'home', 'library');
  const projectsDir = () => path.join(dir, 'user', 'briefstack-projects');
  const sessionsDir = () => path.join(dir, 'home', 'sessions');

  it('init reports what it created, then that nothing changed', async () => {
    const first = capture(dir);
    expect(await main(['init'], first.io)).toBe(0);
    expect(first.err).toEqual([]);
    const entry = projectsDir().replace(/\\/g, '/');
    const sessionsEntry = sessionsDir().replace(/\\/g, '/');
    const settings = path.join(dir, 'repo', '.claude', 'settings.local.json');
    expect(first.out).toEqual([
      `Created the personal library in ${libraryDir()}.`,
      'Initialised a git repository in the library.',
      'Committed the change to the library repository.',
      `Created the projects folder ${projectsDir()}.`,
      `Created the sessions folder ${sessionsDir()}.`,
      `Added ${entry} to permissions.additionalDirectories in ${settings}.`,
      `Added ${sessionsEntry} to permissions.additionalDirectories in ${settings}.`,
    ]);

    const second = capture(dir);
    expect(await main(['init'], second.io)).toBe(0);
    expect(second.out).toEqual([
      `The personal library in ${libraryDir()} is already set up; nothing changed.`,
      `Projects folder: ${projectsDir()}.`,
      `Sessions folder: ${sessionsDir()}.`,
      `${entry} is already in permissions.additionalDirectories in ${settings}.`,
      `${sessionsEntry} is already in permissions.additionalDirectories in ${settings}.`,
    ]);
  });

  it('init speaks Spanish and reports invalid settings', async () => {
    await writeTree(path.join(dir, 'repo'), { '.claude/settings.local.json': '{' });
    const run = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['init'], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('no es JSON válido, así que no se ha tocado');
  });

  it('add, list, show and context work end to end', async () => {
    await main(['init'], capture(dir).io);
    await writeTree(dir, {
      'pref.md': '---\nsummary: Writes in British English.\n---\n# Preferences\n\n- British English everywhere.\n',
      'idea.md': 'A podcast planner.\n',
    });

    const add = capture(dir);
    expect(await main(['library', 'add', 'profile', 'preferences', '--from', 'pref.md'], add.io)).toBe(0);
    expect(add.out).toEqual([
      'Created [[profile/preferences]] (profile/preferences.md).',
      'Updated INDEX.md.',
      'Committed the change to the library repository.',
    ]);

    const list = capture(dir);
    expect(await main(['library', 'list', 'profile'], list.io)).toBe(0);
    expect(list.out).toEqual(['profile/preferences — Writes in British English.']);

    const show = capture(dir);
    expect(await main(['library', 'show', 'profile', 'preferences'], show.io)).toBe(0);
    expect(show.out).toEqual(['# Preferences\n\n- British English everywhere.']);

    const context = capture(dir);
    expect(await main(['library', 'context', '--idea', 'idea.md'], context.io)).toBe(0);
    expect(context.out[0]).toMatch(/^# Library context\n/);
    expect(context.out[0]).toContain('- British English everywhere.');

    const es = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['library', 'context', '--idea', 'idea.md'], es.io)).toBe(0);
    expect(es.out[0]).toMatch(/^# Contexto de la biblioteca\n/);
    expect(es.out[0]).toContain('## Perfil del usuario (profile/)');
  });

  it('records a project with its status block', async () => {
    await main(['init'], capture(dir).io);
    await writeTree(dir, {
      'p.md': '---\ntarget: claude-code\npath: ~/briefstack-projects/podcast\nstatus: created\nprofile: balanced\nsummary: Podcast planner.\n---\n# Podcast\n',
    });
    const run = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['library', 'add', 'projects', 'podcast', '--from', 'p.md'], run.io)).toBe(0);
    expect(run.out).toContain('Estado del proyecto: created, destino claude-code, perfil balanced.');
    expect(await readFile(path.join(libraryDir(), 'projects', 'podcast.md'), 'utf8')).toMatch(/^---\nstatusFormat: 1\nslug: podcast\n/);
  });

  it('links a project note to its creation session', async () => {
    await main(['init'], capture(dir).io);
    await writeTree(dir, {
      'p.md': '---\ntarget: claude-code\npath: ~/briefstack-projects/podcast\nstatus: created\nprofile: balanced\nsummary: Podcast planner.\n---\n# Podcast\n',
    });
    const run = capture(dir);
    expect(await main(['library', 'add', 'projects', 'podcast', '--from', 'p.md', '--session', 'abc-1'], run.io)).toBe(0);
    const text = await readFile(path.join(libraryDir(), 'projects', 'podcast.md'), 'utf8');
    expect(text).toMatch(/\ncreated: \d{4}-\d{2}-\d{2}\nsession: abc-1\n/);

    const bad = capture(dir);
    expect(await main(['library', 'add', 'projects', 'other', '--from', 'p.md', '--session', 'a/b'], bad.io)).toBe(1);
    expect(bad.err.at(-1)).toContain('"a/b" is not a valid session id');
    // Only project notes record a session.
    expect(await main(['library', 'add', 'profile', 'x', '--from', 'p.md', '--session', 'abc-1'], bad.io)).toBe(2);
  });

  it('context and list work without a library', async () => {
    await writeTree(dir, { 'idea.md': 'Anything.\n' });
    const context = capture(dir);
    expect(await main(['library', 'context', '--idea', 'idea.md'], context.io)).toBe(0);
    expect(context.out[0]).toContain(`No personal library at ${libraryDir()} yet`);

    const list = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['library', 'list'], list.io)).toBe(0);
    expect(list.out).toEqual([`Aún no hay biblioteca personal en ${libraryDir()}. Ejecuta "briefstack init".`]);
  });

  it('rejects secrets in Spanish and writes nothing', async () => {
    await main(['init'], capture(dir).io);
    // Built by concatenation so secret scanners do not flag the repo.
    const fakeToken = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789AB';
    await writeTree(dir, { 's.md': `token: "${fakeToken}"\n` });
    const run = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['library', 'add', 'profile', 'keys', '--from', 's.md'], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('parece contener un secreto (línea 1)');
    await expect(readFile(path.join(libraryDir(), 'profile', 'keys.md'), 'utf8')).rejects.toThrow();
  });

  it('exits 2 on usage errors and 1 on library errors', async () => {
    const run = capture(dir);
    expect(await main(['init', 'extra'], run.io)).toBe(2);
    expect(await main(['library'], run.io)).toBe(2);
    expect(await main(['library', 'add', 'profile', 'x'], run.io)).toBe(2);
    expect(await main(['library', 'context'], run.io)).toBe(2);
    expect(await main(['library', 'context', '--idea', 'i.md', '--limit', 'two'], run.io)).toBe(2);
    expect(await main(['library', 'add', 'profile', 'x', '--from', 'missing.md'], run.io)).toBe(1);
    expect(run.err.at(-1)).toBe(`No personal library at ${libraryDir()}. Run "briefstack init" first.`);
    expect(await main(['library', 'list', 'nope'], run.io)).toBe(1);
    expect(run.err.at(-1)).toContain('Unknown library section "nope"');
  });
});

describe('cli: paths', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli-paths'));
  });
  afterEach(() => cleanup());

  const json = (run: Captured) => JSON.parse(run.out.join('\n')) as Record<string, unknown>;

  it('reports where things live, before and after init', async () => {
    const before = capture(dir);
    expect(await main(['paths', '--json'], before.io)).toBe(0);
    expect(json(before)).toEqual({
      home: path.join(dir, 'home'),
      configFile: path.join(dir, 'home', 'config.json'),
      libraryDir: path.join(dir, 'home', 'library'),
      libraryExists: false,
      projectsDir: path.join(dir, 'user', 'briefstack-projects'),
      sessionsDir: path.join(dir, 'home', 'sessions'),
      repoDir: path.join(dir, 'repo'),
      allowedDirs: [],
    });

    await main(['init'], capture(dir).io);
    const after = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['paths'], after.io)).toBe(0);
    expect(after.out).toEqual([
      `Carpeta de briefstack: ${path.join(dir, 'home')}`,
      `Biblioteca personal: ${path.join(dir, 'home', 'library')}`,
      `Carpeta de proyectos: ${path.join(dir, 'user', 'briefstack-projects')}`,
      `Sesiones: ${path.join(dir, 'home', 'sessions')}`,
      `Carpetas permitidas en .claude/settings.local.json: ${[
        path.join(dir, 'user', 'briefstack-projects'),
        path.join(dir, 'home', 'sessions'),
      ]
        .map((item) => item.replace(/\\/g, '/'))
        .join(', ')}`,
    ]);
  });

  it('checks an output folder: state and whether Claude Code may already write there', async () => {
    await main(['init'], capture(dir).io);
    const projects = path.join(dir, 'user', 'briefstack-projects');
    await writeTree(dir, { 'user/briefstack-projects/full/a.md': 'x', 'elsewhere/file.txt': 'x' });
    await mkdir(path.join(projects, 'empty'));

    const check = async (target: string) => {
      const run = capture(dir);
      expect(await main(['paths', 'check', target, '--json'], run.io)).toBe(0);
      return json(run);
    };
    expect(await check(path.join(projects, 'new'))).toEqual({
      outDir: path.join(projects, 'new'),
      status: 'missing',
      overlaps: null,
      allowed: true,
      allowedBy: projects.replace(/\\/g, '/'),
    });
    expect(await check(path.join(projects, 'full'))).toMatchObject({ status: 'nonEmpty', allowed: true });
    expect(await check(path.join(projects, 'empty'))).toMatchObject({ status: 'empty', allowed: true });
    expect(await check('elsewhere/new')).toMatchObject({
      outDir: path.join(dir, 'elsewhere', 'new'),
      status: 'missing',
      allowed: false,
      allowedBy: null,
    });
    expect(await check('elsewhere/file.txt')).toMatchObject({ status: 'notADirectory' });
    expect(await check(path.join(dir, 'home', 'library', 'x'))).toMatchObject({
      status: 'forbidden',
      overlaps: { root: 'library', path: path.join(dir, 'home', 'library') },
    });

    const text = capture(dir);
    expect(await main(['paths', 'check', 'elsewhere/new'], text.io)).toBe(0);
    expect(text.out).toEqual([
      `${path.join(dir, 'elsewhere', 'new')} does not exist yet; scaffold will create it.`,
      `Not in .claude/settings.local.json: run /add-dir ${path.join(dir, 'elsewhere', 'new')} in Claude Code before generating (folders added with /add-dir last for the session and are not visible here).`,
    ]);
    const forbidden = capture(dir);
    expect(await main(['paths', 'check', path.join(dir, 'home')], forbidden.io)).toBe(0);
    expect(forbidden.out[0]).toContain('it overlaps the personal library');
  });

  it('exits 2 on usage errors', async () => {
    const run = capture(dir);
    expect(await main(['paths', 'check'], run.io)).toBe(2);
    expect(await main(['paths', 'list'], run.io)).toBe(2);
    expect(await main(['paths', 'check', 'a', 'b'], run.io)).toBe(2);
    expect(await main(['paths', '--yaml'], run.io)).toBe(2);
  });
});

describe('cli: commit', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli-commit'));
  });
  afterEach(() => cleanup());

  const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd })).stdout.trim();

  it('commits the prepared project once, respecting its .gitignore', async () => {
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(specInput()), 'utf8');
    expect(await main(['scaffold', 'spec.json', 'proj'], capture(dir).io)).toBe(0);
    const project = path.join(dir, 'proj');
    await writeFile(path.join(project, '.env'), 'TOKEN=dummy\n', 'utf8');

    const run = capture(dir);
    expect(await main(['commit', 'proj'], run.io)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out).toEqual([`Committed the prepared project in ${project}.`]);
    expect(await git(project, ['log', '--format=%s|%an'])).toBe('Prepare the project with briefstack|briefstack');
    expect(await git(project, ['status', '--porcelain'])).toBe('');
    const tracked = (await git(project, ['ls-files'])).split('\n');
    expect(tracked).toContain('docs/BRIEF.md');
    expect(tracked).toContain('.briefstack/spec.json');
    expect(tracked).not.toContain('.env');

    const again = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['commit', 'proj'], again.io)).toBe(0);
    expect(again.out).toEqual([`No hay nada que confirmar en ${project}.`]);
    expect(await git(project, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('refuses a folder briefstack did not create', async () => {
    await writeTree(path.join(dir, 'foreign'), { 'README.md': 'x' });
    const run = capture(dir);
    expect(await main(['commit', 'foreign'], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('was not created by briefstack');
    expect(await main(['commit'], run.io)).toBe(2);
  });
});

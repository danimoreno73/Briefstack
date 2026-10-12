import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

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

  it('init reports what it created, then that nothing changed', async () => {
    const first = capture(dir);
    expect(await main(['init'], first.io)).toBe(0);
    expect(first.err).toEqual([]);
    const entry = projectsDir().replace(/\\/g, '/');
    const settings = path.join(dir, 'repo', '.claude', 'settings.local.json');
    expect(first.out).toEqual([
      `Created the personal library in ${libraryDir()}.`,
      'Initialised a git repository in the library.',
      'Committed the change to the library repository.',
      `Created the projects folder ${projectsDir()}.`,
      `Added ${entry} to permissions.additionalDirectories in ${settings}.`,
    ]);

    const second = capture(dir);
    expect(await main(['init'], second.io)).toBe(0);
    expect(second.out).toEqual([
      `The personal library in ${libraryDir()} is already set up; nothing changed.`,
      `Projects folder: ${projectsDir()}.`,
      `${entry} is already in permissions.additionalDirectories in ${settings}.`,
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
    await writeTree(dir, { 's.md': 'token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"\n' });
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

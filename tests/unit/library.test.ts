import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addNote,
  buildLibraryContext,
  datedEntries,
  initLibrary,
  listNotes,
  readNote,
  readProjectStatus,
  saveNote,
} from '../../src/library/index.js';
import { renderLibraryContext } from '../../src/i18n/library.js';
import { resolvesWikilink } from '../../src/validate/links.js';
import { BriefstackError } from '../../src/errors.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function allFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await allFiles(root, child)));
    else files.push(child);
  }
  return files.sort();
}

describe('personal library', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let libraryDir: string;
  let projectsDir: string;
  let sessionsDir: string;
  let repoDir: string;
  const now = new Date('2026-10-12T10:00:00Z');

  const init = () => initLibrary({ libraryDir, projectsDir, sessionsDir, repoDir });
  const source = async (name: string, text: string): Promise<string> => {
    const file = path.join(dir, 'input', name);
    await writeTree(path.join(dir, 'input'), { [name]: text });
    return file;
  };
  const read = (relative: string) => readFile(path.join(libraryDir, ...relative.split('/')), 'utf8');
  const settingsFile = () => path.join(repoDir, '.claude', 'settings.local.json');

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('library'));
    libraryDir = path.join(dir, 'home', 'library');
    projectsDir = path.join(dir, 'projects');
    sessionsDir = path.join(dir, 'home', 'sessions');
    repoDir = path.join(dir, 'repo');
  });
  afterEach(() => cleanup());

  describe('init', () => {
    it('creates the tree, a git repo with one commit, the projects and sessions folders and their settings entries', async () => {
      const result = await init();
      expect(result.created).toEqual([
        './',
        'profile/',
        'templates/',
        'skills/',
        'projects/',
        'log/',
        'INDEX.md',
        'lessons.md',
        'log/INDEX.md',
      ]);
      expect(result.warnings).toEqual([]);
      expect(result.gitInitialised).toBe(true);
      expect(result.committed).toBe(true);
      expect(result.projectsDirCreated).toBe(true);
      expect((await stat(projectsDir)).isDirectory()).toBe(true);
      expect(result.sessionsDirCreated).toBe(true);
      expect((await stat(sessionsDir)).isDirectory()).toBe(true);
      expect(git(libraryDir, ['log', '--format=%s|%an']).trim()).toBe('library: initialise|briefstack');
      expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');

      const entry = projectsDir.replace(/\\/g, '/');
      const sessionsEntry = sessionsDir.replace(/\\/g, '/');
      expect(result.settings).toEqual([
        { file: settingsFile(), entry, added: true },
        { file: settingsFile(), entry: sessionsEntry, added: true },
      ]);
      expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toEqual({
        permissions: { additionalDirectories: [entry, sessionsEntry] },
      });
    });

    it('changes nothing on a second run and never overwrites files', async () => {
      await init();
      await writeFile(path.join(libraryDir, 'lessons.md'), '# Mine\n', 'utf8');
      const settingsBefore = await readFile(settingsFile(), 'utf8');

      const again = await init();
      expect(again.created).toEqual([]);
      expect(again.gitInitialised).toBe(false);
      expect(again.committed).toBe(false);
      expect(again.projectsDirCreated).toBe(false);
      expect(again.sessionsDirCreated).toBe(false);
      expect(again.settings.map((item) => item.added)).toEqual([false, false]);
      expect(await read('lessons.md')).toBe('# Mine\n');
      expect(await readFile(settingsFile(), 'utf8')).toBe(settingsBefore);
      expect(git(libraryDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    });

    it('fills in missing files of an existing library', async () => {
      await writeTree(libraryDir, { 'INDEX.md': '# My index\n' });
      const result = await init();
      expect(result.created).not.toContain('./');
      expect(result.created).not.toContain('INDEX.md');
      expect(await read('INDEX.md')).toBe('# My index\n');
    });

    it('merges with an existing settings.local.json', async () => {
      await writeTree(repoDir, {
        '.claude/settings.local.json': JSON.stringify({
          permissions: { allow: ['Read'], additionalDirectories: ['/elsewhere'] },
          model: 'x',
        }),
      });
      await init();
      expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toEqual({
        permissions: {
          allow: ['Read'],
          additionalDirectories: ['/elsewhere', projectsDir.replace(/\\/g, '/'), sessionsDir.replace(/\\/g, '/')],
        },
        model: 'x',
      });
    });

    it('stops before creating anything when settings.local.json is invalid', async () => {
      await writeTree(repoDir, { '.claude/settings.local.json': '{ broken' });
      await expect(init()).rejects.toMatchObject({ code: 'init.settingsInvalidJson' });
      expect(await readFile(settingsFile(), 'utf8')).toBe('{ broken');
      await expect(stat(libraryDir)).rejects.toThrow();
    });
  });

  describe('add', () => {
    beforeEach(async () => {
      await init();
    });

    it('creates a note, indexes it and commits', async () => {
      const from = await source('style.md', '---\nsummary: Prefers short answers.\n---\n# Style\n\nShort answers, no fluff.\n');
      const result = await addNote({ libraryDir, section: 'profile', name: 'style', fromFile: from, now });
      expect(result).toMatchObject({ action: 'created', file: 'profile/style.md', indexUpdated: true, committed: true });
      expect(await read('profile/style.md')).toBe('# Style\n\nShort answers, no fluff.\n');
      expect(await read('INDEX.md')).toContain('## Profile\n\n- [[profile/style]] — Prefers short answers.\n');
      expect(git(libraryDir, ['log', '-1', '--format=%s']).trim()).toBe('library: add profile/style');
      expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
    });

    it('appends to an existing note and commits again', async () => {
      const first = await source('a.md', '# Tools\n\nUses VS Code.\n');
      const second = await source('b.md', 'Prefers pnpm.\n');
      await addNote({ libraryDir, section: 'profile', name: 'tools', fromFile: first, now });
      const later = new Date('2026-11-02T23:30:00Z');
      const result = await addNote({ libraryDir, section: 'profile', name: 'tools', fromFile: second, now: later });
      expect(result.action).toBe('appended');
      expect(result.indexUpdated).toBe(false);
      // The first content is not dated; every addition after it is.
      expect(await read('profile/tools.md')).toBe('# Tools\n\nUses VS Code.\n\n### 2026-11-02\n\nPrefers pnpm.\n');
      expect(await read('INDEX.md')).toContain('- [[profile/tools]] — Tools\n');
      expect(git(libraryDir, ['log', '--format=%s']).trim().split('\n')).toEqual([
        'library: update profile/tools',
        'library: add profile/tools',
        'library: initialise',
      ]);
    });

    it('uses the configured git identity when there is one', async () => {
      git(libraryDir, ['config', 'user.name', 'Ana']);
      git(libraryDir, ['config', 'user.email', 'ana@example.org']);
      await addNote({ libraryDir, section: 'skills', name: 'review', fromFile: await source('s.md', 'Review steps.\n'), now });
      expect(git(libraryDir, ['log', '-1', '--format=%an']).trim()).toBe('Ana');
    });

    it('appends lessons to lessons.md without a name', async () => {
      const from = await source('l.md', '- Do not ask for the language twice.\n');
      const result = await addNote({ libraryDir, section: 'lessons', fromFile: from, now });
      expect(result).toMatchObject({ action: 'appended', file: 'lessons.md', committed: true });
      expect(await read('lessons.md')).toMatch(/at the end\.\n\n### 2026-10-12\n\n- Do not ask for the language twice\.\n$/);
    });

    it('dates every addition so old entries can be found later', async () => {
      const dates = ['2026-01-05T08:00:00Z', '2026-03-20T12:00:00Z', '2026-03-20T18:00:00Z'];
      for (const [index, date] of dates.entries()) {
        const from = await source(`l${index}.md`, `- Lesson ${index}.\n`);
        await addNote({ libraryDir, section: 'lessons', fromFile: from, now: new Date(date) });
      }
      const lessons = await read('lessons.md');
      expect(datedEntries(lessons)).toEqual(['2026-01-05', '2026-03-20', '2026-03-20']);
      expect(lessons).toMatch(/### 2026-01-05\n\n- Lesson 0\.\n\n### 2026-03-20\n\n- Lesson 1\./);
    });

    it('dates lessons even when lessons.md has to be recreated', async () => {
      await rm(path.join(libraryDir, 'lessons.md'));
      await addNote({ libraryDir, section: 'lessons', fromFile: await source('l.md', '- Again.\n'), now });
      expect(datedEntries(await read('lessons.md'))).toEqual(['2026-10-12']);
    });

    it('keeps a log index, newest first', async () => {
      await addNote({ libraryDir, section: 'log', name: '2026-10-01-garden', fromFile: await source('1.md', '# Garden session\n'), now });
      await addNote({ libraryDir, section: 'log', name: '2026-10-12-novel', fromFile: await source('2.md', '# Novel session\n'), now });
      const logIndex = await read('log/INDEX.md');
      expect(logIndex.indexOf('[[log/2026-10-12-novel]]')).toBeLessThan(logIndex.indexOf('[[log/2026-10-01-garden]]'));
      expect(await read('INDEX.md')).not.toContain('2026-10-01-garden');
      const notes = await listNotes(libraryDir, 'log');
      expect(notes.map((note) => note.name)).toEqual(['2026-10-01-garden', '2026-10-12-novel']);
    });

    it('writes and updates the project status block', async () => {
      const created = await source(
        'p.md',
        '---\ntarget: claude-app\npath: ~/briefstack-projects/garden\nstatus: created\nprofile: saver\nsummary: Garden planner for a small plot.\n---\n# Garden\n',
      );
      const result = await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: created, now });
      expect(result.status).toEqual({
        statusFormat: 1,
        slug: 'garden',
        target: 'claude-app',
        path: '~/briefstack-projects/garden',
        status: 'created',
        profile: 'saver',
        updated: '2026-10-12',
        created: '2026-10-12',
        summary: 'Garden planner for a small plot.',
      });
      expect(await read('INDEX.md')).toContain('- [[projects/garden]] — Garden planner for a small plot.');

      const later = new Date('2026-11-02T00:00:00Z');
      await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: await source('q.md', '---\nstatus: active\n---\nFirst harvest.\n'), now: later });
      const text = await read('projects/garden.md');
      expect(readProjectStatus(text, 'garden.md')).toEqual({
        ok: true,
        status: { ...result.status, status: 'active', updated: '2026-11-02' },
      });
      expect(text).toMatch(/# Garden\n\n### 2026-11-02\n\nFirst harvest\.\n$/);
    });

    it('links a project note to its creation session and keeps the first one', async () => {
      const fields = '---\ntarget: claude-code\npath: ~/p/garden\nstatus: created\nprofile: balanced\n---\n# Garden\n';
      const created = await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: await source('p.md', fields), session: 's-1', now });
      expect(created.status).toMatchObject({ created: '2026-10-12', session: 's-1' });

      const later = new Date('2026-11-02T00:00:00Z');
      const update = await source('q.md', '---\nstatus: active\n---\nMore.\n');
      const again = await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: update, session: 's-2', now: later });
      expect(again.status).toMatchObject({ created: '2026-10-12', session: 's-1', updated: '2026-11-02' });

      // An older note without a session gets the first one given, and no invented creation date.
      await writeTree(libraryDir, {
        'projects/old.md':
          '---\nstatusFormat: 1\nslug: old\ntarget: claude-code\npath: ~/p/old\nstatus: active\nprofile: saver\nupdated: 2026-01-01\nsummary: Old.\n---\n# Old\n',
      });
      const old = await addNote({ libraryDir, section: 'projects', name: 'old', fromFile: update, session: 's-3', now: later });
      expect(old.status).toMatchObject({ session: 's-3' });
      expect(old.status?.created).toBeUndefined();
    });

    it('refuses an invalid session id before writing anything', async () => {
      const fields = '---\ntarget: claude-code\npath: ~/p/x\nstatus: created\nprofile: balanced\n---\n# X\n';
      const from = await source('p.md', fields);
      await expect(addNote({ libraryDir, section: 'projects', name: 'x', fromFile: from, session: '../up', now })).rejects.toMatchObject({
        code: 'events.invalidSession',
      });
      await expect(stat(path.join(libraryDir, 'projects', 'x.md'))).rejects.toThrow();
    });

    it('refuses a project note without the required status fields', async () => {
      const from = await source('p.md', '---\ntarget: claude-code\n---\n# X\n');
      await expect(addNote({ libraryDir, section: 'projects', name: 'x', fromFile: from, now })).rejects.toMatchObject({
        code: 'library.invalidProjectStatus',
      });
      await expect(stat(path.join(libraryDir, 'projects', 'x.md'))).rejects.toThrow();
    });

    it('rejects secrets and writes nothing', async () => {
      const before = await allFiles(libraryDir);
      const indexBefore = await read('INDEX.md');
      // Built by concatenation so secret scanners do not flag the repo.
      const fakeKey = 'sk-' + 'ant-api03-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
      const from = await source('s.md', `# Keys\n\nANTHROPIC_API_KEY=${fakeKey}\n`);
      const error = await addNote({ libraryDir, section: 'profile', name: 'keys', fromFile: from, now }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BriefstackError);
      expect(error).toMatchObject({ code: 'library.secretContent', params: { lines: [3] } });
      expect(await allFiles(libraryDir)).toEqual(before);
      expect(await read('INDEX.md')).toBe(indexBefore);
      expect(git(libraryDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    });

    it('rejects bad sections, names and missing files', async () => {
      const from = await source('a.md', 'x\n');
      await expect(addNote({ libraryDir, section: 'nope', name: 'a', fromFile: from })).rejects.toMatchObject({ code: 'library.unknownSection' });
      await expect(addNote({ libraryDir, section: 'profile', name: 'Bad Name', fromFile: from })).rejects.toMatchObject({ code: 'library.invalidName' });
      await expect(addNote({ libraryDir, section: 'profile', name: '../x', fromFile: from })).rejects.toMatchObject({ code: 'library.invalidName' });
      await expect(addNote({ libraryDir, section: 'profile', fromFile: from })).rejects.toMatchObject({ code: 'library.nameRequired' });
      await expect(addNote({ libraryDir, section: 'lessons', name: 'x', fromFile: from })).rejects.toMatchObject({ code: 'library.nameNotAllowed' });
      await expect(addNote({ libraryDir, section: 'profile', name: 'a', fromFile: path.join(dir, 'none.md') })).rejects.toMatchObject({ code: 'library.fileNotFound' });
      await expect(addNote({ libraryDir, section: 'profile', name: 'a', fromFile: await source('e.md', '---\nsummary: x\n---\n\n') })).rejects.toMatchObject({ code: 'library.emptyContent' });
    });

    it('needs an initialised library', async () => {
      const from = await source('a.md', 'x\n');
      await expect(addNote({ libraryDir: path.join(dir, 'other'), section: 'profile', name: 'a', fromFile: from })).rejects.toMatchObject({ code: 'library.notInitialised' });
    });

    it('keeps every wikilink in the index resolvable', async () => {
      await addNote({ libraryDir, section: 'profile', name: 'style', fromFile: await source('a.md', 'Short.\n'), now });
      await addNote({ libraryDir, section: 'skills', name: 'triage', fromFile: await source('b.md', 'Triage.\n'), now });
      await addNote({ libraryDir, section: 'log', name: '2026-10-12-a', fromFile: await source('c.md', 'Session.\n'), now });
      const files = await allFiles(libraryDir);
      const paths = { files, directories: [] };
      const links = [...(await read('INDEX.md')).matchAll(/\[\[([^\]]+)\]\]/g), ...(await read('log/INDEX.md')).matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1] ?? '');
      expect(links.length).toBeGreaterThanOrEqual(5);
      for (const link of links) expect(resolvesWikilink(link, paths), link).toBe(true);
    });
  });

  describe('add from text and save', () => {
    beforeEach(async () => {
      await init();
    });
    const log = () => git(libraryDir, ['log', '--format=%s']).trim().split('\n');
    const project = '---\ntarget: claude-code\npath: ~/p/garden\nstatus: created\nprofile: balanced\nsummary: Garden.\n---\n# Garden\n';

    it('addNote takes the content as text, exactly like a file', async () => {
      const result = await addNote({ libraryDir, section: 'profile', name: 'style', text: '---\nsummary: Short.\n---\nShort answers.\n', now });
      expect(result).toMatchObject({ action: 'created', file: 'profile/style.md', indexUpdated: true, committed: true });
      expect(await read('profile/style.md')).toBe('Short answers.\n');
      await expect(addNote({ libraryDir, section: 'profile', name: 'x', text: '   \n', now })).rejects.toMatchObject({
        code: 'library.emptyContent',
        params: { file: 'profile/x.md' },
      });
    });

    it('creates, appends with a date heading, rewrites, and leaves identical text alone', async () => {
      const created = await saveNote({ libraryDir, section: 'profile', name: 'tools', text: '# Tools\n\nUses VS Code.\n', now });
      expect(created).toMatchObject({ mode: 'create', indexUpdated: true, committed: true });
      expect(await read('INDEX.md')).toContain('- [[profile/tools]] — Tools\n');

      const later = new Date('2026-11-02T08:00:00Z');
      const appended = await saveNote({ libraryDir, section: 'profile', name: 'tools', text: '# Tools\n\nUses VS Code.\n\nPrefers pnpm.\n', now: later });
      expect(appended).toMatchObject({ mode: 'append', committed: true });
      expect(await read('profile/tools.md')).toBe('# Tools\n\nUses VS Code.\n\n### 2026-11-02\n\nPrefers pnpm.\n');

      // Text added on the old last line is an edit, so a rewrite.
      const current = await read('profile/tools.md');
      const rewritten = await saveNote({ libraryDir, section: 'profile', name: 'tools', text: current.replace('pnpm.', 'pnpm and npm.'), now: later });
      expect(rewritten).toMatchObject({ mode: 'rewrite', committed: true });
      expect(await read('profile/tools.md')).toBe(current.replace('pnpm.', 'pnpm and npm.'));

      const same = await saveNote({ libraryDir, section: 'profile', name: 'tools', text: `${await read('profile/tools.md')}\n\n`, now: later });
      expect(same).toMatchObject({ mode: 'unchanged', committed: false, indexUpdated: false });
      expect(log()).toEqual(['library: update profile/tools', 'library: update profile/tools', 'library: add profile/tools', 'library: initialise']);
      expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
    });

    it('refuses secrets and invalid project status blocks, writing nothing', async () => {
      // Built by concatenation so secret scanners do not flag the repo.
      const fakeToken = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789AB';
      await expect(saveNote({ libraryDir, section: 'profile', name: 'keys', text: `# Keys\n\ntoken: ${fakeToken}\n`, now })).rejects.toMatchObject({
        code: 'library.secretContent',
        params: { file: 'profile/keys.md', lines: [3] },
      });
      await expect(saveNote({ libraryDir, section: 'projects', name: 'bad', text: '---\ntarget: web\n---\n# Bad\n', now })).rejects.toMatchObject({
        code: 'library.invalidProjectStatus',
      });
      await expect(stat(path.join(libraryDir, 'profile', 'keys.md'))).rejects.toThrow();
      await expect(stat(path.join(libraryDir, 'projects', 'bad.md'))).rejects.toThrow();
      expect(log()).toEqual(['library: initialise']);
    });

    it('keeps the project status block valid and briefstack fields in place on a rewrite', async () => {
      await addNote({ libraryDir, section: 'projects', name: 'garden', text: project, session: 's-1', now });
      const later = new Date('2026-11-02T08:00:00Z');
      const text = (await read('projects/garden.md'))
        .replace('status: created', 'status: active')
        .replace('summary: Garden.', 'summary: Garden, now active.')
        .replace('session: s-1\n', '');
      const result = await saveNote({ libraryDir, section: 'projects', name: 'garden', text, now: later });
      expect(result.mode).toBe('rewrite');
      expect(result.status).toMatchObject({ status: 'active', updated: '2026-11-02', created: '2026-10-12', session: 's-1' });
      expect(readProjectStatus(await read('projects/garden.md'), 'f')).toEqual({ ok: true, status: result.status });
      expect(await read('INDEX.md')).toContain('- [[projects/garden]] — Garden, now active.');

      // An addition at the end of a project note is dated and bumps `updated`.
      const latest = new Date('2026-12-01T08:00:00Z');
      const appended = await saveNote({ libraryDir, section: 'projects', name: 'garden', text: `${await read('projects/garden.md')}\nFirst harvest.\n`, now: latest });
      expect(appended).toMatchObject({ mode: 'append', status: { updated: '2026-12-01' } });
      expect(await read('projects/garden.md')).toMatch(/### 2026-12-01\n\nFirst harvest\.\n$/);

      // A rewrite that changes the slug is refused.
      const renamed = (await read('projects/garden.md')).replace('slug: garden', 'slug: other').replace('First harvest.', 'Edited.');
      await expect(saveNote({ libraryDir, section: 'projects', name: 'garden', text: renamed, now })).rejects.toMatchObject({
        code: 'library.invalidProjectStatus',
      });
    });

    it('creates a project note from text without a status block line for statusFormat', async () => {
      const result = await saveNote({ libraryDir, section: 'projects', name: 'garden', text: project, now });
      expect(result).toMatchObject({ mode: 'create', status: { statusFormat: 1, slug: 'garden', created: '2026-10-12' } });
      expect(await read('projects/garden.md')).toMatch(/^---\nstatusFormat: 1\ntarget: claude-code\n/);
    });

    it('keeps the log index for log notes', async () => {
      await saveNote({ libraryDir, section: 'log', name: '2026-10-12-garden', text: '# Garden session\n', now });
      expect(await read('log/INDEX.md')).toContain('[[log/2026-10-12-garden]] — Garden session');
    });
  });

  describe('list and show', () => {
    it('lists notes with their index summary and shows one', async () => {
      await init();
      await addNote({ libraryDir, section: 'profile', name: 'style', fromFile: await source('a.md', '---\nsummary: Short.\n---\nShort answers.\n'), now });
      const all = await listNotes(libraryDir);
      expect(all.map((note) => [note.file, note.summary])).toEqual([
        ['profile/style.md', 'Short.'],
        ['lessons.md', 'What was over-asked and what the user corrected.'],
      ]);
      expect((await readNote(libraryDir, 'profile', 'style')).text).toBe('Short answers.\n');
      expect((await readNote(libraryDir, 'lessons')).file).toBe('lessons.md');
      await expect(readNote(libraryDir, 'profile', 'none')).rejects.toMatchObject({ code: 'library.noteNotFound' });
    });

    it('lists nothing for a missing library', async () => {
      expect(await listNotes(libraryDir)).toEqual([]);
    });
  });

  describe('context', () => {
    it('works on a missing library', async () => {
      const idea = await source('idea.md', 'A garden planner.\n');
      const context = await buildLibraryContext({ libraryDir, ideaFile: idea });
      expect(context.exists).toBe(false);
      expect(renderLibraryContext(context, 'en')).toContain('No personal library at');
      expect(renderLibraryContext(context, 'es')).toContain('Aún no hay biblioteca personal');
    });

    it('works on an empty library', async () => {
      await init();
      const context = await buildLibraryContext({ libraryDir, ideaFile: await source('idea.md', 'A garden planner.\n') });
      const text = renderLibraryContext(context, 'en');
      expect(text).toContain('## Library index (INDEX.md)');
      expect(text).toContain('No profile notes yet.');
      expect(text).toContain('No past project shares keywords with this idea.');
    });

    it('ranks the similar project note first', async () => {
      await init();
      const project = (summary: string) =>
        `---\ntarget: claude-code\npath: ~/p\nstatus: created\nprofile: balanced\nsummary: ${summary}\n---\n`;
      await addNote({ libraryDir, section: 'projects', name: 'novel', fromFile: await source('n.md', `${project('Mystery novel set in Seville.')}# Novel\n`), now });
      await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: await source('g.md', `${project('Vegetable garden planner with watering calendar.')}# Garden\n`), now });
      await addNote({ libraryDir, section: 'projects', name: 'budget', fromFile: await source('b.md', `${project('Household budget tracker.')}# Budget\n`), now });

      const idea = await source('idea.md', 'I want a planner for my vegetable garden: what to plant, a watering schedule and a harvest tracker.\n');
      const context = await buildLibraryContext({ libraryDir, ideaFile: idea, limit: 2 });
      expect(context.similarProjects.map((note) => note.file)).toEqual(['projects/garden.md', 'projects/budget.md']);
      expect(context.similarProjects[0]?.shared).toEqual(['garden', 'planner', 'vegetable', 'watering']);
      const text = renderLibraryContext(context, 'en');
      expect(text).toContain('### projects/garden.md');
      expect(text).not.toContain('### projects/novel.md');
    });

    it('learning: answers from a similar project reach the gap analysis through its session log', async () => {
      await init();
      const log = '---\nsummary: Creation of chess-check.\n---\n# Log\n\n- Meaning of "legal": syntax only (changed by the user).\n';
      await addNote({ libraryDir, section: 'log', name: '2026-10-12-chess-check', fromFile: await source('l.md', log), now });
      const project =
        '---\ntarget: claude-code\npath: ~/p\nstatus: created\nprofile: balanced\nsummary: Chess FEN checker with Stockfish.\n---\n' +
        '# chess-check\n\nSession: [[log/2026-10-12-chess-check]], missing: [[log/2026-01-01-gone]]\n';
      await addNote({ libraryDir, section: 'projects', name: 'chess-check', fromFile: await source('p.md', project), now });

      const idea = await source('idea.md', 'A chess FEN checker that asks Stockfish for the best move.\n');
      const context = await buildLibraryContext({ libraryDir, ideaFile: idea });
      expect(context.similarProjects[0]?.logs.map((item) => item.file)).toEqual(['log/2026-10-12-chess-check.md']);
      const text = renderLibraryContext(context, 'en');
      expect(text).toContain('#### log/2026-10-12-chess-check.md (session log of this project');
      expect(text).toContain('Meaning of "legal": syntax only (changed by the user).');
    });

    it('learning: a preference recorded in a first creation reaches the second gap analysis', async () => {
      await init();
      // First creation: the user states a preference and the flow records it.
      const preference = 'Always write project docs in British English and keep CLAUDE.md under 30 lines.';
      await addNote({ libraryDir, section: 'profile', name: 'preferences', fromFile: await source('pref.md', `# Preferences\n\n- ${preference}\n`), now });
      await addNote({ libraryDir, section: 'lessons', fromFile: await source('lesson.md', '- Do not ask which editor the user uses.\n'), now });

      // Second creation: the gap analysis input for a new idea already has it.
      const idea = await source('idea2.md', 'A reading tracker for the books I borrow.\n');
      const text = renderLibraryContext(await buildLibraryContext({ libraryDir, ideaFile: idea }), 'en');
      expect(text).toContain(preference);
      expect(text).toContain('### profile/preferences.md');
      expect(text).toContain('Do not ask which editor the user uses.');
    });
  });
});

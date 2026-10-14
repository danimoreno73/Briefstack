import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addNote, gitCommit, initLibrary, listProjects } from '../../src/library/index.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

const statusBlock = (slug: string, extra = ''): string =>
  `---\nstatusFormat: 1\nslug: ${slug}\ntarget: claude-code\npath: ~/p/${slug}\nstatus: active\nprofile: saver\nupdated: 2026-01-01\n${extra}summary: ${slug} summary.\n---\n`;

describe('listProjects', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let libraryDir: string;
  const now = new Date('2026-10-12T10:00:00Z');

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('projects'));
    libraryDir = path.join(dir, 'home', 'library');
  });
  afterEach(() => cleanup());

  it('lists nothing for a missing library', async () => {
    expect(await listProjects(libraryDir)).toEqual([]);
  });

  it('gives name, created date and session, newest first, and lists invalid notes with their issues', async () => {
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'p'), sessionsDir: path.join(dir, 's'), repoDir: path.join(dir, 'repo') });
    await writeTree(dir, {
      'in/new.md': '---\ntarget: claude-app\npath: ~/p/garden\nstatus: created\nprofile: balanced\n---\n# Garden planner\n\nText.\n',
    });
    await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: path.join(dir, 'in', 'new.md'), session: 'sess-1', now });

    // An older note without `created`: the date of its first library commit.
    await writeTree(libraryDir, { 'projects/old.md': `${statusBlock('old')}No heading here.\n` });
    process.env.GIT_AUTHOR_DATE = '2025-05-05T12:00:00Z';
    try {
      await gitCommit(libraryDir, ['projects/old.md'], 'library: add projects/old');
    } finally {
      delete process.env.GIT_AUTHOR_DATE;
    }

    // Uncommitted, with an explicit date; and two broken notes.
    await writeTree(libraryDir, {
      'projects/zeta.md': `${statusBlock('zeta', 'created: 2026-03-01\n')}# Zeta\n`,
      'projects/broken.md': '---\nslug: broken\ntarget: web\n---\n# Broken one\n',
      'projects/unclosed.md': '---\nslug: x\n# Never closed\n',
    });

    const list = await listProjects(libraryDir);
    expect(list.map((item) => [item.slug, item.name, item.created ?? null, item.session ?? null])).toEqual([
      ['garden', 'Garden planner', '2026-10-12', 'sess-1'],
      ['zeta', 'Zeta', '2026-03-01', null],
      ['old', 'old', '2025-05-05', null],
      ['broken', 'Broken one', null, null],
      ['unclosed', 'Never closed', null, null],
    ]);
    expect(list[0]).toMatchObject({ file: 'projects/garden.md', status: { status: 'created', target: 'claude-app' } });
    expect(list[0]?.issues).toBeUndefined();
    expect(list[3]?.status).toBeUndefined();
    expect(list[3]?.issues?.some((issue) => issue.startsWith('target'))).toBe(true);
    expect(list[4]?.issues).toEqual(['frontmatter: frontmatter.unclosed']);
  });

  it('works without a git repository', async () => {
    await writeTree(libraryDir, { 'projects/solo.md': `${statusBlock('solo')}# Solo\n` });
    expect(await listProjects(libraryDir)).toEqual([
      expect.objectContaining({ slug: 'solo', name: 'Solo', status: expect.objectContaining({ slug: 'solo' }) }),
    ]);
    expect((await listProjects(libraryDir))[0]?.created).toBeUndefined();
  });
});

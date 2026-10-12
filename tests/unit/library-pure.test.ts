import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefstackError } from '../../src/errors.js';
import {
  allowingDirectory,
  INDEX_TEMPLATE,
  LOG_INDEX_TEMPLATE,
  cleanSummary,
  keywords,
  mergeAdditionalDirectory,
  normaliseDirForCompare,
  parseIndexEntries,
  prependIndexEntry,
  rankProjects,
  readProjectStatus,
  settingsDirEntry,
  summaryFromBody,
  updateProjectNote,
  upsertIndexEntry,
  writeProjectNote,
  type ProjectStatus,
} from '../../src/library/index.js';

const win = { pathApi: path.win32, caseInsensitive: true };
const mac = { pathApi: path.posix, caseInsensitive: true };
const linux = { pathApi: path.posix, caseInsensitive: false };

describe('additionalDirectories merge', () => {
  it('writes the entry absolute with forward slashes', () => {
    expect(settingsDirEntry('C:\\Users\\ana\\briefstack-projects', win)).toBe('C:/Users/ana/briefstack-projects');
    expect(settingsDirEntry('/home/ana/briefstack-projects/', linux)).toBe('/home/ana/briefstack-projects');
  });

  it('normalises separators, trailing slashes and case where paths are case-insensitive', () => {
    expect(normaliseDirForCompare('C:\\Work\\Projects\\', win)).toBe('c:/work/projects');
    expect(normaliseDirForCompare('/Users/Ana/P/', mac)).toBe('/users/ana/p');
    expect(normaliseDirForCompare('/home/Ana/P/', linux)).toBe('/home/Ana/P');
    expect(normaliseDirForCompare('/', linux)).toBe('/');
  });

  it('creates the structure when there is no file', () => {
    const merge = mergeAdditionalDirectory(undefined, '/home/ana/p', linux, 'f');
    expect(merge.added).toBe(true);
    expect(JSON.parse(merge.text)).toEqual({ permissions: { additionalDirectories: ['/home/ana/p'] } });
  });

  it('keeps other keys and entries', () => {
    const text = JSON.stringify({
      env: { A: '1' },
      permissions: { allow: ['Bash(npm test)'], additionalDirectories: ['/data'] },
    });
    const merge = mergeAdditionalDirectory(text, '/home/ana/p', linux, 'f');
    expect(JSON.parse(merge.text)).toEqual({
      env: { A: '1' },
      permissions: { allow: ['Bash(npm test)'], additionalDirectories: ['/data', '/home/ana/p'] },
    });
  });

  it('does not duplicate an entry written with other separators or case on Windows', () => {
    const text = JSON.stringify({ permissions: { additionalDirectories: ['c:\\users\\ana\\briefstack-projects\\'] } });
    const merge = mergeAdditionalDirectory(text, 'C:\\Users\\Ana\\briefstack-projects', win, 'f');
    expect(merge).toEqual({ text, added: false, entry: 'C:/Users/Ana/briefstack-projects' });
  });

  it('treats case as significant on Linux', () => {
    const text = JSON.stringify({ permissions: { additionalDirectories: ['/home/ana/P'] } });
    expect(mergeAdditionalDirectory(text, '/home/ana/p', linux, 'f').added).toBe(true);
    expect(mergeAdditionalDirectory(text, '/home/ana/p', mac, 'f').added).toBe(false);
  });

  it('rejects invalid JSON and wrong shapes with coded errors', () => {
    const code = (text: string) => {
      try {
        mergeAdditionalDirectory(text, '/p', linux, 'f');
      } catch (error) {
        return error instanceof BriefstackError ? [error.code, (error.params as { field?: string }).field] : [];
      }
      return [];
    };
    expect(code('{ nope')).toEqual(['init.settingsInvalidJson', undefined]);
    expect(code('[]')).toEqual(['init.settingsInvalidShape', 'root']);
    expect(code('{"permissions": 1}')).toEqual(['init.settingsInvalidShape', 'permissions']);
    expect(code('{"permissions": {"additionalDirectories": "x"}}')).toEqual([
      'init.settingsInvalidShape',
      'additionalDirectories',
    ]);
  });
});

describe('allowing directory', () => {
  it('finds the entry that covers a folder or one of its parents, on Windows', () => {
    const entries = ['D:/data', 'C:/Users/Ana/briefstack-projects'];
    expect(allowingDirectory('c:\\users\\ana\\briefstack-projects\\novel', entries, win)).toBe(
      'C:/Users/Ana/briefstack-projects',
    );
    expect(allowingDirectory('C:\\Users\\Ana\\briefstack-projects', entries, win)).toBe(
      'C:/Users/Ana/briefstack-projects',
    );
    expect(allowingDirectory('C:\\Users\\Ana\\briefstack-projects-old\\x', entries, win)).toBeUndefined();
    expect(allowingDirectory('C:\\Users\\Ana\\Documents\\tfg', entries, win)).toBeUndefined();
  });

  it('follows case rules on POSIX and skips entries that are not fully absolute', () => {
    expect(allowingDirectory('/home/ana/p/x', ['/home/ana/P'], linux)).toBeUndefined();
    expect(allowingDirectory('/Users/ana/p/x', ['/Users/ana/P'], mac)).toBe('/Users/ana/P');
    expect(allowingDirectory('C:\\x\\y', ['/x', 'x', '~/x'], win)).toBeUndefined();
    expect(allowingDirectory('/home/ana/x', ['x', '/home/ana'], linux)).toBe('/home/ana');
  });
});

describe('index entries', () => {
  it('adds an entry under its heading and parses it back', () => {
    const first = upsertIndexEntry(INDEX_TEMPLATE, 'Profile', 'profile/style', 'Short answers.');
    const second = upsertIndexEntry(first.text, 'Profile', 'profile/tools', 'Uses VS Code.');
    expect(second.text).toContain(
      '## Profile\n\n- [[profile/style]] — Short answers.\n- [[profile/tools]] — Uses VS Code.\n\n## Projects',
    );
    expect(parseIndexEntries(second.text).filter((entry) => entry.heading === 'Profile')).toEqual([
      { link: 'profile/style', summary: 'Short answers.', heading: 'Profile' },
      { link: 'profile/tools', summary: 'Uses VS Code.', heading: 'Profile' },
    ]);
  });

  it('updates an entry in place and leaves it alone without a summary', () => {
    const { text } = upsertIndexEntry(INDEX_TEMPLATE, 'Projects', 'projects/a', 'Old.');
    const updated = upsertIndexEntry(text, 'Projects', 'projects/a', 'New.');
    expect(updated.text).toContain('- [[projects/a]] — New.');
    expect(updated.text).not.toContain('Old.');
    expect(upsertIndexEntry(updated.text, 'Projects', 'projects/a', undefined)).toEqual({
      text: updated.text,
      changed: false,
    });
  });

  it('adds a missing heading at the end', () => {
    const { text } = upsertIndexEntry('# Index\n', 'Skills', 'skills/x', 'X.');
    expect(text).toBe('# Index\n\n## Skills\n\n- [[skills/x]] — X.\n');
  });

  it('puts new log entries first', () => {
    const first = prependIndexEntry(LOG_INDEX_TEMPLATE, 'log/2026-01-01-a', 'A.');
    const second = prependIndexEntry(first.text, 'log/2026-02-01-b', 'B.');
    expect(parseIndexEntries(second.text).map((entry) => entry.link)).toEqual(['log/2026-02-01-b', 'log/2026-01-01-a']);
  });

  it('cleans summaries', () => {
    expect(cleanSummary('  two\nlines [[x]] ')).toBe('two lines x');
    expect(cleanSummary('a'.repeat(200))).toHaveLength(120);
    expect(summaryFromBody('\n# Title here\n\nbody')).toBe('Title here');
  });
});

describe('project status block', () => {
  const status: ProjectStatus = {
    statusFormat: 1,
    slug: 'garden-planner',
    target: 'claude-code',
    path: '~/briefstack-projects/garden-planner',
    status: 'created',
    profile: 'balanced',
    updated: '2026-10-12',
    summary: 'Plan a vegetable garden: seasons, beds and rotation.',
  };

  it('writes and reads back', () => {
    const text = writeProjectNote(status, '# Garden planner\n');
    expect(text.startsWith('---\nstatusFormat: 1\nslug: garden-planner\n')).toBe(true);
    expect(text.endsWith('---\n# Garden planner\n')).toBe(true);
    expect(readProjectStatus(text, 'f')).toEqual({ ok: true, status });
  });

  it('updates the fields and keeps the body', () => {
    const text = writeProjectNote(status, '# Garden planner\n\nNotes.\n');
    const next = updateProjectNote(text, { ...status, status: 'active', updated: '2026-11-01' }, 'f');
    expect(readProjectStatus(next, 'f')).toEqual({ ok: true, status: { ...status, status: 'active', updated: '2026-11-01' } });
    expect(next.endsWith('---\n# Garden planner\n\nNotes.\n')).toBe(true);
  });

  it('reports what is wrong', () => {
    const result = readProjectStatus('---\nslug: x\ntarget: web\n---\n', 'f');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.startsWith('target'))).toBe(true);
  });
});

describe('similarity', () => {
  it('extracts keywords without stop words or short tokens', () => {
    expect(keywords('The garden planner for my garden, and a plan to water it.')).toEqual([
      'garden',
      'planner',
      'plan',
      'water',
    ]);
    expect(keywords('Una novela de misterio en Sevilla')).toEqual(['novela', 'misterio', 'sevilla']);
  });

  it('ranks by shared keywords, ties in code-point order', () => {
    const notes = [
      { file: 'projects/b.md', text: 'garden watering' },
      { file: 'projects/a.md', text: 'garden compost' },
      { file: 'projects/c.md', text: 'garden compost watering' },
      { file: 'projects/d.md', text: 'novel' },
    ];
    const ranked = rankProjects('garden compost watering schedule', notes, 3);
    expect(ranked.map((note) => [note.file, note.score])).toEqual([
      ['projects/c.md', 3],
      ['projects/a.md', 2],
      ['projects/b.md', 2],
    ]);
    expect(ranked[0]?.shared).toEqual(['compost', 'garden', 'watering']);
    expect(rankProjects('garden', notes, 0)).toEqual([]);
  });
});

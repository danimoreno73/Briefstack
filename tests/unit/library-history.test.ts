import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibrary, libraryHistory, parseHistory, revertLibraryCommit, saveNote } from '../../src/library/index.js';
import { tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('library history', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let libraryDir: string;
  const now = new Date('2026-10-12T10:00:00Z');

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('history'));
    libraryDir = path.join(dir, 'home', 'library');
  });
  afterEach(() => cleanup());

  const init = () => initLibrary({ libraryDir, projectsDir: path.join(dir, 'p'), sessionsDir: path.join(dir, 's'), repoDir: path.join(dir, 'repo') });
  const save = (text: string) => saveNote({ libraryDir, section: 'profile', name: 'style', text, now });
  const read = () => readFile(path.join(libraryDir, 'profile', 'style.md'), 'utf8');

  it('is empty without a library repo', async () => {
    expect(await libraryHistory(libraryDir)).toEqual([]);
  });

  it('lists commits newest first with their files, up to the limit', async () => {
    await init();
    await save('# Style\n\nShort answers.\n');
    const history = await libraryHistory(libraryDir, { limit: 10 });
    expect(history.map((commit) => [commit.subject, commit.files])).toEqual([
      ['library: add profile/style', ['INDEX.md', 'profile/style.md']],
      ['library: initialise', ['INDEX.md', 'lessons.md', 'log/INDEX.md']],
    ]);
    const [latest] = history;
    expect(latest?.sha).toBe(git(libraryDir, ['rev-parse', 'HEAD']));
    expect(latest?.sha.startsWith(latest.shortSha)).toBe(true);
    expect(Number.isNaN(Date.parse(latest?.date ?? ''))).toBe(false);
    expect(await libraryHistory(libraryDir, { limit: 1 })).toHaveLength(1);
    await expect(libraryHistory(libraryDir, { limit: 0 })).rejects.toThrow(RangeError);
  });

  it('parses odd subjects and file names robustly', () => {
    const output = '\x1eaaaa1111\x1faaaa\x1f2026-10-12T10:00:00+02:00\x1fsubject with | and :\n\nnotes/ñandú file.md\n\x1ebad\n';
    expect(parseHistory(output)).toEqual([
      { sha: 'aaaa1111', shortSha: 'aaaa', date: '2026-10-12T10:00:00+02:00', subject: 'subject with | and :', files: ['notes/ñandú file.md'] },
    ]);
  });

  it('reverts a commit with a new commit', async () => {
    await init();
    await save('# Style\n\nShort answers.\n');
    const [added] = await libraryHistory(libraryDir);
    const sha = await revertLibraryCommit(libraryDir, added?.shortSha ?? '');
    expect(sha).toBe(git(libraryDir, ['rev-parse', 'HEAD']));
    expect(git(libraryDir, ['log', '-1', '--format=%s|%an'])).toBe('Revert "library: add profile/style"|briefstack');
    await expect(read()).rejects.toThrow();
    expect(git(libraryDir, ['status', '--porcelain'])).toBe('');
  });

  it('refuses unknown commits and uncommitted changes, ignoring untracked files', async () => {
    await init();
    await save('# Style\n\nShort answers.\n');
    await expect(revertLibraryCommit(libraryDir, 'zzzz')).rejects.toMatchObject({ code: 'library.commitNotFound' });
    await expect(revertLibraryCommit(libraryDir, '--help')).rejects.toMatchObject({ code: 'library.commitNotFound' });
    await expect(revertLibraryCommit(libraryDir, 'deadbeefdeadbeef')).rejects.toMatchObject({ code: 'library.commitNotFound' });

    const [added] = await libraryHistory(libraryDir);
    await writeFile(path.join(libraryDir, 'profile', 'style.md'), 'edited by hand\n', 'utf8');
    await expect(revertLibraryCommit(libraryDir, added?.sha ?? '')).rejects.toMatchObject({ code: 'library.dirtyTree' });
    git(libraryDir, ['checkout', '--', 'profile/style.md']);

    await writeFile(path.join(libraryDir, 'untracked.md'), 'x\n', 'utf8');
    await expect(revertLibraryCommit(libraryDir, added?.sha ?? '')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it('aborts on a conflict and leaves the library as it was', async () => {
    await init();
    await save('# Style\n\nOne.\n');
    await save('# Style\n\nTwo.\n');
    await save('# Style\n\nThree.\n');
    const [, middle] = await libraryHistory(libraryDir);
    const head = git(libraryDir, ['rev-parse', 'HEAD']);

    await expect(revertLibraryCommit(libraryDir, middle?.sha ?? '')).rejects.toMatchObject({
      code: 'library.revertConflict',
      params: { sha: middle?.sha, files: ['profile/style.md'] },
    });
    expect(git(libraryDir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(libraryDir, ['status', '--porcelain'])).toBe('');
    expect(await read()).toBe('# Style\n\nThree.\n');
  });
});

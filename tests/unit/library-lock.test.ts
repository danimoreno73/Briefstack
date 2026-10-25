import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addNote, initLibrary, libraryLockDir, saveNote, withLibraryLock } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe('library queue', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let lockRoot: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('library-lock'));
    lockRoot = path.join(dir, 'locks');
  });
  afterEach(() => cleanup());

  it('names one lock per library, the same for every spelling of its path, outside the library', () => {
    const a = libraryLockDir(path.join(dir, 'lib'), lockRoot);
    expect(libraryLockDir(path.join(dir, 'x', '..', 'lib'), lockRoot)).toBe(a);
    expect(libraryLockDir(path.join(dir, 'other'), lockRoot)).not.toBe(a);
    expect(path.dirname(a)).toBe(lockRoot);
    if (process.platform === 'win32') expect(libraryLockDir(path.join(dir, 'LIB'), lockRoot)).toBe(a);
  });

  it('runs changes one after another inside one process, and frees the lock after an error', async () => {
    const library = path.join(dir, 'lib');
    const order: string[] = [];
    const step = (name: string, ms: number, fail = false) =>
      withLibraryLock(
        library,
        async () => {
          order.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, ms));
          order.push(`${name}:end`);
          if (fail) throw new Error(name);
          return name;
        },
        { lockRoot },
      );
    const results = await Promise.allSettled([step('a', 40), step('b', 5, true), step('c', 5)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(await exists(libraryLockDir(library, lockRoot))).toBe(false);
  });

  it('waits for a lock another live process holds, then takes it', async () => {
    const library = path.join(dir, 'lib');
    const lock = libraryLockDir(library, lockRoot);
    // A real other process owns it.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: other.pid, at: new Date().toISOString() }));
      let ran = false;
      const waiting = withLibraryLock(library, async () => (ran = true), { lockRoot, retryMs: 10 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ran).toBe(false);
      await import('node:fs/promises').then((fs) => fs.rm(lock, { recursive: true, force: true }));
      await waiting;
      expect(ran).toBe(true);
    } finally {
      other.kill();
    }
  });

  it('takes over a lock whose process is gone, or that is too old', async () => {
    const library = path.join(dir, 'lib');
    const lock = libraryLockDir(library, lockRoot);
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: gone.pid }));
    expect(await withLibraryLock(library, async () => 'taken', { lockRoot, retryMs: 10, timeoutMs: 2000 })).toBe('taken');

    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    expect(await withLibraryLock(library, async () => 'old', { lockRoot, retryMs: 10, staleMs: 0, timeoutMs: 2000 })).toBe('old');
  });

  it('never takes over the lock of a live process whose write takes longer than staleMs (backlog 1, A7)', async () => {
    const library = path.join(dir, 'lib');
    const staleMs = 300;
    const holdMs = 1500;
    const fixture = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'hold-library-lock.ts');
    const other = spawn(process.execPath, ['--import', 'tsx', fixture, library, lockRoot, String(staleMs), String(holdMs)], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      let output = '';
      const said = (word: string) => output.split('\n').includes(word);
      const held = new Promise<void>((resolve, reject) => {
        other.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (said('held')) resolve();
        });
        other.once('exit', (code) => reject(new Error(`the other process ended first (${code ?? 'signal'})`)));
      });
      await held;
      // Far past staleMs while the other process still writes: the lock must still be its own.
      let doneBeforeUs: boolean | undefined;
      await withLibraryLock(library, async () => (doneBeforeUs = said('done')), { lockRoot, staleMs, retryMs: 10, timeoutMs: 20_000 });
      expect(doneBeforeUs).toBe(true);
    } finally {
      other.kill();
    }
  }, 30_000);

  it('gives up with library.busy and runs nothing when the lock stays taken', async () => {
    const library = path.join(dir, 'lib');
    const lock = libraryLockDir(library, lockRoot);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    let ran = false;
    await expect(withLibraryLock(library, async () => (ran = true), { lockRoot, retryMs: 10, timeoutMs: 80 })).rejects.toMatchObject({
      code: 'library.busy',
    });
    expect(ran).toBe(false);
  });

  it('never takes a lock another process took over first: a fresh lock found in place of the stale one is put back', async () => {
    const library = path.join(dir, 'lib');
    const lock = libraryLockDir(library, lockRoot);
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: gone.pid, token: 'dead' }));
      // Between our look and our take-over, another process takes the stale lock and holds it.
      const onStale = async () => {
        await rm(lock, { recursive: true, force: true });
        await mkdir(lock);
        await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: other.pid, token: 'fresh' }));
      };
      let ran = false;
      await expect(withLibraryLock(library, async () => (ran = true), { lockRoot, retryMs: 10, timeoutMs: 150, onStale })).rejects.toMatchObject({
        code: 'library.busy',
      });
      expect(ran).toBe(false);
      expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ token: 'fresh' });
    } finally {
      other.kill();
    }
  });

  it('removes the lock at the end only while it is still its own', async () => {
    const library = path.join(dir, 'lib');
    const lock = libraryLockDir(library, lockRoot);
    const result = await withLibraryLock(
      library,
      async () => {
        // The change ran past the stale age and another process took the lock over.
        await rm(lock, { recursive: true, force: true });
        await mkdir(lock);
        await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid + 1, token: 'other' }));
        return 'saved';
      },
      { lockRoot },
    );
    expect(result).toBe('saved');
    expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ token: 'other' });
  });

  it('a lock that cannot be removed after a good change is reported, keeps the result, and does not block the next change', async () => {
    const library = path.join(dir, 'lib');
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on('warning', onWarning);
    try {
      const failing = async () => {
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      };
      expect(await withLibraryLock(library, async () => 'saved', { lockRoot, removeLock: failing })).toBe('saved');
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings.some((message) => message.includes('could not be removed') && message.includes('(EPERM)'))).toBe(true);
      // The lock left behind is this process's own, held by no call: the next change takes it over at once.
      expect(await withLibraryLock(library, async () => 'next', { lockRoot, retryMs: 10, timeoutMs: 500 })).toBe('next');
      expect(await exists(libraryLockDir(library, lockRoot))).toBe(false);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('two creations finishing together: every note, every index line and every commit is there', async () => {
    const libraryDir = path.join(dir, 'home', 'library');
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'projects'), sessionsDir: path.join(dir, 'home', 'sessions'), repoDir: path.join(dir, 'repo') });
    const now = new Date('2026-10-17T10:00:00Z');
    const notes = ['alpha', 'bravo', 'charlie', 'delta'];
    await Promise.all([
      ...notes.map((name) =>
        addNote({
          libraryDir,
          section: 'projects',
          name,
          text: `---\ntarget: claude-code\npath: /projects/${name}\nstatus: created\nprofile: saver\nsummary: ${name} project.\n---\n# ${name}\n`,
          now,
        }),
      ),
      addNote({ libraryDir, section: 'lessons', text: 'Do not ask twice.\n', now }),
      saveNote({ libraryDir, section: 'profile', name: 'preferences', text: '# Preferences\n\nShort.\n', now }),
    ]);
    const index = await readFile(path.join(libraryDir, 'INDEX.md'), 'utf8');
    for (const name of notes) expect(index).toContain(`projects/${name}`);
    expect(index).toContain('profile/preferences');
    const log = git(libraryDir, ['log', '--format=%s']);
    for (const name of notes) expect(log).toContain(`library: add projects/${name}`);
    expect(log).toContain('library: add profile/preferences');
    expect(log).toContain('library: update lessons');
    expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
  });
});

import { spawn } from 'node:child_process';
import * as realFs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { libraryLockDir, withLibraryLock } from '../../src/library/index.js';
import { tempDir } from '../helpers.js';

// Only this process's reads of `owner.json` are slowed down, by `slow.ms`.
const slow = vi.hoisted(() => ({ ms: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      if (slow.ms > 0 && String(args[0]).endsWith('owner.json')) await new Promise((resolve) => setTimeout(resolve, slow.ms));
      return real.readFile(...args);
    },
  };
});

describe('library lock: the judge of a stale lock', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('library-lock-judge'));
  });
  afterEach(() => {
    slow.ms = 0;
    return cleanup();
  });

  // Step 23: the age was taken after the read of owner.json, so a read slower
  // than staleMs made a lock freshened every 20 ms look old.
  it('does not count its own slow read of owner.json as the age of a live, fresh lock', async () => {
    const library = path.join(dir, 'lib');
    const lockRoot = path.join(dir, 'locks');
    const lock = libraryLockDir(library, lockRoot);
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    // The live holder freshens its lock every 20 ms, as keepFresh does.
    const fresh = setInterval(() => {
      const now = new Date();
      void realFs.utimes(lock, now, now).catch(() => undefined);
    }, 20);
    try {
      await realFs.mkdir(lock, { recursive: true });
      await realFs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: other.pid, token: 'live' }));
      slow.ms = 400;
      let ran = false;
      await expect(withLibraryLock(library, async () => (ran = true), { lockRoot, staleMs: 300, retryMs: 10, timeoutMs: 1500 })).rejects.toMatchObject({
        code: 'library.busy',
      });
      expect(ran).toBe(false);
      slow.ms = 0;
      expect(JSON.parse(await realFs.readFile(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ token: 'live' });
    } finally {
      clearInterval(fresh);
      other.kill();
    }
  }, 10_000);
});

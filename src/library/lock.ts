import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BriefstackError } from '../errors.js';

/**
 * One queue for every change to a library (BRIEF-phase-4 §3.2): two
 * creations that finish together run `library add` in two processes, and a
 * note's read, its `INDEX.md` update and its commit must not interleave with
 * another's, or `git` would run twice at once (`index.lock`) and an index
 * line could be lost.
 *
 * Inside one process the calls are chained. Across processes the lock is a
 * folder in the OS temp folder, named after the library path, created with
 * `mkdir` (atomic on every platform). Nothing is written in the library
 * itself. A lock left by a process that died is taken over once its owner is
 * gone or it is older than `staleMs`.
 */

export interface LibraryLockOptions {
  /** Where lock folders live. Default `<os temp>/briefstack-locks`. */
  lockRoot?: string;
  /** How long to wait for the lock before `library.busy`. Default 60 s. */
  timeoutMs?: number;
  /** A lock older than this is taken over. Default 2 minutes. */
  staleMs?: number;
  /** Time between tries. Default 50 ms. */
  retryMs?: number;
}

const chains = new Map<string, Promise<unknown>>();

/** The lock folder of a library: the same for every spelling of its path on this machine. */
export function libraryLockDir(libraryDir: string, lockRoot: string = path.join(os.tmpdir(), 'briefstack-locks')): string {
  let key = path.resolve(libraryDir);
  if (process.platform === 'win32' || process.platform === 'darwin') key = key.toLowerCase();
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(lockRoot, `library-${hash}.lock`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(dir: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(dir);
    if (Date.now() - info.mtimeMs > staleMs) return true;
    const owner = JSON.parse(await readFile(path.join(dir, 'owner.json'), 'utf8')) as { pid?: unknown };
    return typeof owner.pid === 'number' && owner.pid !== process.pid && !alive(owner.pid);
  } catch {
    // Gone already, or its owner file is not written yet: not stale.
    return false;
  }
}

async function acquire(dir: string, options: Required<Omit<LibraryLockOptions, 'lockRoot'>>): Promise<void> {
  await mkdir(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      await mkdir(dir);
      await writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await isStale(dir, options.staleMs)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new BriefstackError('library.busy', { waitedMs: options.timeoutMs });
    await new Promise((resolve) => setTimeout(resolve, options.retryMs));
  }
}

/** Runs `work` while holding the library's lock, after every change queued before it. */
export async function withLibraryLock<T>(libraryDir: string, work: () => Promise<T>, options: LibraryLockOptions = {}): Promise<T> {
  const dir = libraryLockDir(libraryDir, options.lockRoot);
  const settings = {
    timeoutMs: options.timeoutMs ?? 60_000,
    staleMs: options.staleMs ?? 120_000,
    retryMs: options.retryMs ?? 50,
  };
  const previous = chains.get(dir) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    await acquire(dir, settings);
    try {
      return await work();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
  const tail = run.catch(() => undefined);
  chains.set(dir, tail);
  void tail.then(() => {
    if (chains.get(dir) === tail) chains.delete(dir);
  });
  return run;
}

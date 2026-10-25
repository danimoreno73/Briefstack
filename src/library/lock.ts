import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
 * gone or it is older than `staleMs`. The holder sets the lock's time to now
 * while it holds it, so a long write is never judged old.
 *
 * Each lock names its owner (`owner.json`: pid and a token of its own). A
 * stale lock is first renamed to a name only the taker uses, which only one
 * process can do, and removed only if it is still the stale lock that was
 * judged; a holder removes the lock at the end only while it is still its
 * own, so it never removes a lock another process took over.
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
  /** Tests: runs after a lock was judged stale and before it is taken over. */
  onStale?: (() => Promise<void>) | undefined;
  /** Tests: how the lock folder is removed at the end. */
  removeLock?: ((dir: string) => Promise<void>) | undefined;
}

type LockSettings = Required<Pick<LibraryLockOptions, 'timeoutMs' | 'staleMs' | 'retryMs'>> & Pick<LibraryLockOptions, 'onStale' | 'removeLock'>;

const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });

const chains = new Map<string, Promise<unknown>>();
/** Tokens of the locks this process holds now. */
const held = new Set<string>();

interface Owner {
  pid?: unknown;
  token?: unknown;
}

async function readOwner(dir: string): Promise<Owner | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'owner.json'), 'utf8')) as Owner;
  } catch {
    return undefined;
  }
}

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

/** The owner token of a stale lock (`null` when it has none), or `undefined` when the lock is live or gone. */
async function staleToken(dir: string, staleMs: number): Promise<string | null | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch {
    return undefined;
  }
  const owner = await readOwner(dir);
  const token = typeof owner?.token === 'string' ? owner.token : null;
  if (Date.now() - mtimeMs > staleMs) return token;
  // No owner file yet: someone is writing it.
  if (owner === undefined || typeof owner.pid !== 'number') return undefined;
  // Left by this process (a removal that failed): no call here holds it.
  if (owner.pid === process.pid) return token !== null && !held.has(token) ? token : undefined;
  return alive(owner.pid) ? undefined : token;
}

/**
 * Moves a stale lock out of the way: renamed first (only one taker can), then
 * removed if it is the lock that was judged stale. If another taker replaced
 * it in between, it is put back.
 */
async function takeOver(dir: string, judged: string | null): Promise<void> {
  const aside = `${dir}.stale-${randomUUID()}`;
  try {
    await rename(dir, aside);
  } catch {
    // Someone else moved or removed it first.
    return;
  }
  const owner = await readOwner(aside);
  const token = typeof owner?.token === 'string' ? owner.token : null;
  if (token === judged) {
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  // A fresh lock, taken by another process after our look: give it back.
  await rename(aside, dir).catch(() => undefined);
}

async function acquire(dir: string, options: LockSettings): Promise<string> {
  await mkdir(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    let made = false;
    try {
      await mkdir(dir);
      made = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (made) {
      const token = randomUUID();
      held.add(token);
      try {
        await writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 'utf8');
      } catch (error) {
        held.delete(token);
        await removeDir(dir).catch(() => undefined);
        throw error;
      }
      return token;
    }
    const stale = await staleToken(dir, options.staleMs);
    if (stale !== undefined) {
      await options.onStale?.();
      await takeOver(dir, stale);
      continue;
    }
    if (Date.now() > deadline) throw new BriefstackError('library.busy', { waitedMs: options.timeoutMs });
    await new Promise((resolve) => setTimeout(resolve, options.retryMs));
  }
}

/**
 * Removes the lock if it is still ours. A failure is reported as a warning
 * and never replaces the result of the change, which is already saved; the
 * lock left behind is taken over as stale.
 */
async function release(dir: string, token: string, remove: (dir: string) => Promise<void>): Promise<void> {
  try {
    const owner = await readOwner(dir);
    if (owner?.token !== token) return;
    await remove(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    process.emitWarning(`The library lock could not be removed after the change (${code}); it will be taken over as stale.`, { code: 'BRIEFSTACK_LIBRARY_LOCK' });
  } finally {
    // Not held any more either way: a lock left behind by a failed removal is stale for this process.
    held.delete(token);
  }
}

/**
 * While the lock is held, sets its folder's time to now every quarter of
 * `staleMs`, so a write that takes longer than `staleMs` keeps a fresh lock
 * and no other process takes it over. Only a lock whose holder stopped (a
 * process that died, or a reused pid) grows old. Returns the stop function.
 */
function keepFresh(dir: string, token: string, staleMs: number): () => void {
  const timer = setInterval(
    () => {
      void (async () => {
        // Never freshen a lock that is no longer this holder's.
        if ((await readOwner(dir))?.token !== token) return;
        const now = new Date();
        await utimes(dir, now, now);
      })().catch(() => undefined);
    },
    Math.max(10, Math.floor(staleMs / 4)),
  );
  timer.unref();
  return () => clearInterval(timer);
}

/** Runs `work` while holding the library's lock, after every change queued before it. */
export async function withLibraryLock<T>(libraryDir: string, work: () => Promise<T>, options: LibraryLockOptions = {}): Promise<T> {
  const dir = libraryLockDir(libraryDir, options.lockRoot);
  const settings: LockSettings = {
    timeoutMs: options.timeoutMs ?? 60_000,
    staleMs: options.staleMs ?? 120_000,
    retryMs: options.retryMs ?? 50,
    onStale: options.onStale,
    removeLock: options.removeLock,
  };
  const previous = chains.get(dir) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const token = await acquire(dir, settings);
    const stopFreshening = keepFresh(dir, token, settings.staleMs);
    try {
      return await work();
    } finally {
      stopFreshening();
      await release(dir, token, settings.removeLock ?? removeDir);
    }
  });
  const tail = run.catch(() => undefined);
  chains.set(dir, tail);
  void tail.then(() => {
    if (chains.get(dir) === tail) chains.delete(dir);
  });
  return run;
}

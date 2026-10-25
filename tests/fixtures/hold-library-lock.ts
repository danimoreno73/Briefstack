/**
 * A second process for the library lock test: it takes the lock of a
 * library and holds it for a while, as a slow library write would. Prints
 * `held` once inside and `done` just before it lets go.
 *
 * Arguments: library folder, lock root, staleMs, holdMs.
 */
import { withLibraryLock } from '../../src/library/lock.js';

const [libraryDir, lockRoot, staleMs, holdMs] = process.argv.slice(2);

await withLibraryLock(
  libraryDir as string,
  async () => {
    process.stdout.write('held\n');
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    process.stdout.write('done\n');
  },
  { lockRoot: lockRoot as string, staleMs: Number(staleMs), retryMs: 10, timeoutMs: 30_000 },
);

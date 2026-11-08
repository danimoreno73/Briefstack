/**
 * A second process for the library lock test: it takes the lock of a
 * library and holds it for a while, as a slow library write would. Prints
 * `held` once inside, and writes `doneFile` just before it lets go (a file,
 * not the pipe, so the test never depends on when the pipe delivers).
 *
 * Arguments: library folder, lock root, staleMs, holdMs, doneFile.
 */
import { writeFile } from 'node:fs/promises';
import { withLibraryLock } from '../../src/library/lock.js';

const [libraryDir, lockRoot, staleMs, holdMs, doneFile] = process.argv.slice(2);

await withLibraryLock(
  libraryDir as string,
  async () => {
    process.stdout.write('held\n');
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    await writeFile(doneFile as string, 'done\n', 'utf8');
  },
  { lockRoot: lockRoot as string, staleMs: Number(staleMs), retryMs: 10, timeoutMs: 30_000 },
);

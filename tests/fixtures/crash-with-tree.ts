// Run by tests/unit/creation-process-tree.test.ts in its own process: it
// starts a tracked process that starts a child of its own, writes both pids,
// then dies of an uncaught exception. The `exit` hook of `spawnTracked` must
// end both, as it does for `claude` and its commands when `briefstack web`
// crashes.
// Usage: node --import tsx tests/fixtures/crash-with-tree.ts <parent.cjs> <pidFile>

import { readFile } from 'node:fs/promises';
import { spawnTracked } from '../../src/creation/processTree.js';

const [script, pidFile] = process.argv.slice(2);
if (script === undefined || pidFile === undefined) throw new Error('usage: crash-with-tree.ts <parent.cjs> <pidFile>');
const parent = spawnTracked().spawn({
  command: process.execPath,
  args: [script, pidFile],
  cwd: process.cwd(),
  env: { ...process.env },
  signal: new AbortController().signal,
});
const deadline = Date.now() + 20_000;
while ((await readFile(pidFile, 'utf8').catch(() => '')) === '' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.log(`parent ${String((parent as unknown as { pid: number }).pid)}`);
throw new Error('crash on purpose');

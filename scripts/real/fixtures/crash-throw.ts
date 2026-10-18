// Run by scripts/real/check-server-crash.ts in its own process, never alone.
// It starts one real creation with the creation manager `briefstack web`
// uses (BRIEFSTACK_HOME is the check's temp home, from the environment),
// waits until the creation asks the user something, so a tool call waits
// on the server, and then dies of an uncaught exception. The exit hook of
// `spawnTracked` must end the creation's process tree.
// Usage: node --import tsx scripts/real/fixtures/crash-throw.ts "<idea>"

import { systemPathEnv } from '../../../src/config/index.js';
import { createWebCreations } from '../../../src/creation/wiring.js';
import { PACKAGE_ROOT } from '../../../src/packageRoot.js';

const idea = process.argv[2];
if (idea === undefined || process.env.BRIEFSTACK_HOME === undefined) throw new Error('usage: crash-throw.ts "<idea>", with BRIEFSTACK_HOME set');
const manager = await createWebCreations({ pathEnv: systemPathEnv(), repoDir: PACKAGE_ROOT, lang: 'en' });
const { id } = await manager.create(idea);
console.log(JSON.stringify({ started: id }));
const deadline = Date.now() + 10 * 60_000;
while (manager.get(id).pending === undefined && manager.get(id).status !== 'finished' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const state = manager.get(id);
console.log(JSON.stringify({ pending: state.pending?.kind ?? null, status: state.status, sessionId: state.sessionId ?? null }));
throw new Error('crash on purpose, with a tool call waiting');

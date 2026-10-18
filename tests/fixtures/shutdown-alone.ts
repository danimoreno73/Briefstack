// Run by tests/unit/creation-manager.test.ts in its own process: a top-level
// `await manager.shutdown()` with nothing else keeping the process alive, as in
// the real scripts. Before the fix Node ended it as "unsettled top-level await".
// Usage: node --import tsx tests/fixtures/shutdown-alone.ts <sessionsDir>

import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager } from '../../src/creation/manager.js';

const sessionsDir = process.argv[2];
if (sessionsDir === undefined) throw new Error('usage: shutdown-alone.ts <sessionsDir>');
const manager = new CreationManager({
  runner: new FakeRunner({ steps: parseRecording('{"do":"session","phase":"started"}\n{"do":"turnEnd","message":"Waiting."}') }),
  sessionsDir,
  policy: () => 'ask',
  profile: () => ({ name: 'saver', sessionModel: 'sonnet' }),
});
const { id } = await manager.create('An idea');
while (manager.get(id).awaitingReply === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
await manager.shutdown();
console.log(`shutdown returned: ${manager.get(id).outcome ?? 'none'}`);

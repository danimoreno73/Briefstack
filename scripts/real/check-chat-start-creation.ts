// Real check (BRIEF-phase-4 §5): the chat starts a creation only through the
// confirmation.
//
// The real chat on haiku (low effort) in a temp BRIEFSTACK_HOME. The creation
// manager behind it uses the FAKE creation runner, so no creation session is
// spent: what is checked is the chat → card → confirmation → creation path.
// This script plays the browser:
//   1. it asks the chat to start a creation and DECLINES the card: no
//      creation exists afterwards;
//   2. it asks again and CONFIRMS: exactly one creation exists, with the idea.
// Expected PASS lines for each step, a card each time, and no error notice.
// A few short haiku turns. Run:  npx tsx scripts/real/check-chat-start-creation.ts --yes

import path from 'node:path';
import { ChatManager } from '../../src/chat/manager.js';
import { SdkChatRunner } from '../../src/chat/sdkChatRunner.js';
import { ChatStore } from '../../src/chat/store.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager } from '../../src/creation/manager.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show } from './common.js';

requireConfirmation('Check that the chat starts a creation only through the confirmation (haiku; the creation itself is fake).');

const IDEA = 'A checklist for packing a carry-on bag';
const box = await sandbox('chat-start');
const executable = claudeExecutable();
let ok = true;
let chat: ChatManager | undefined;
const creations = new CreationManager({
  runner: new FakeRunner({ steps: parseRecording('{"do":"session","phase":"started"}\n{"do":"wait","ms":60000}') }),
  sessionsDir: box.sessions,
  policy: () => 'ask',
  profile: () => ({ name: 'saver', sessionModel: 'sonnet', effort: 'low' }),
});

/** Waits for the chat to show a card or to end its turn. */
async function cardOrIdle(c: ChatManager): Promise<string | undefined> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const view = await c.view();
    if (view.pending !== undefined) return view.pending.id;
    if (view.status === 'idle') return undefined;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function idle(c: ChatManager): Promise<void> {
  const deadline = Date.now() + 180_000;
  while ((await c.view()).status !== 'idle' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
}

try {
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);
  const pathEnv = await sandboxLibrary(box);
  chat = await ChatManager.open({
    store: new ChatStore(path.join(box.home, 'chat')),
    runner: new SdkChatRunner({ pathEnv, findExecutable: () => executable }),
    tools: { pathEnv, repoDir: PACKAGE_ROOT, lang: 'en', creations },
    profile: async () => ({ model: 'haiku', effort: 'low' }),
  });

  await chat.send(`Start a new creation with exactly this idea: "${IDEA}". Use the start_creation tool.`);
  const first = await cardOrIdle(chat);
  ok = report('a card was shown for the first request', first !== undefined, first ?? 'no card') && ok;
  if (first !== undefined) chat.confirm(first, 'decline');
  await idle(chat);
  ok = report('declined: no creation exists', creations.list().length === 0, `${creations.list().length} creation(s)`) && ok;

  await chat.send('I changed my mind: please propose it again, I will confirm.');
  const second = await cardOrIdle(chat);
  ok = report('a card was shown for the second request', second !== undefined, second ?? 'no card') && ok;
  if (second !== undefined) chat.confirm(second, 'confirm');
  await idle(chat);
  const list = creations.list();
  ok = report('confirmed: exactly one creation, with the idea', list.length === 1 && list[0]?.idea === IDEA, list.map((c) => c.idea).join(' | ') || 'none') && ok;

  const { messages } = await chat.view();
  for (const message of messages) console.log(`${message.role}: ${message.text ?? message.tool?.name ?? message.notice ?? message.confirmation?.state ?? ''}`);
  ok = report('no error notice', !messages.some((message) => message.role === 'notice'), messages.find((m) => m.role === 'notice')?.detail ?? 'none') && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} finally {
  await chat?.shutdown();
  await creations.shutdown();
  await box.cleanup();
}
process.exit(ok ? 0 : 1);

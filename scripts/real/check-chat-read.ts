// Real check (BRIEF-phase-4 §5): the chat answers from its read tools.
//
// Starts the real chat (SdkChatRunner + ChatManager, as `briefstack web`
// does) on haiku with low effort, in a temp BRIEFSTACK_HOME whose library
// holds one project, "Seed tracker". Asks which projects there are. Expected:
//   1. the session opens with only the briefstack-chat tools (the runner ends
//      it otherwise) and no error notice;
//   2. it calls at least one read tool (list_projects, show_project or
//      search_library);
//   3. the answer names "Seed tracker";
//   4. no confirmation card was shown (nothing to change).
// A few short haiku turns. Run:  npx tsx scripts/real/check-chat-read.ts --yes

import path from 'node:path';
import { ChatManager } from '../../src/chat/manager.js';
import { SdkChatRunner } from '../../src/chat/sdkChatRunner.js';
import { ChatStore } from '../../src/chat/store.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show } from './common.js';

requireConfirmation('Check that the chat answers from its read tools (haiku, a few short turns).');

const box = await sandbox('chat-read');
const executable = claudeExecutable();
let ok = true;
let chat: ChatManager | undefined;
try {
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);
  const pathEnv = await sandboxLibrary(box);
  chat = await ChatManager.open({
    store: new ChatStore(path.join(box.home, 'chat')),
    runner: new SdkChatRunner({ pathEnv, findExecutable: () => executable }),
    tools: { pathEnv, repoDir: PACKAGE_ROOT, lang: 'en' },
    profile: async () => ({ model: 'haiku', effort: 'low' }),
  });
  await chat.send('Which projects do I have in briefstack? Name each one and say where you found it.');
  const deadline = Date.now() + 180_000;
  while ((await chat.view()).status !== 'idle' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  const { messages, status } = await chat.view();
  for (const message of messages) console.log(`${message.role}: ${message.text ?? message.tool?.name ?? message.notice ?? message.confirmation?.card.kind ?? ''}`);

  const tools = messages.filter((message) => message.role === 'tool').map((message) => message.tool?.name ?? '');
  const answer = messages.filter((message) => message.role === 'assistant').map((message) => message.text ?? '').join('\n');
  ok = report('the turn ended', status === 'idle', status) && ok;
  ok = report('no error notice (closed tool list held, session ran)', !messages.some((message) => message.role === 'notice'), messages.find((m) => m.role === 'notice')?.detail ?? 'none') && ok;
  ok = report('a read tool was used', tools.some((name) => ['list_projects', 'show_project', 'search_library'].includes(name)), tools.join(', ') || 'none') && ok;
  ok = report('the answer names the project', answer.includes('Seed tracker'), answer.slice(0, 160) || 'no answer') && ok;
  ok = report('no confirmation card', !messages.some((message) => message.role === 'confirmation'), '') && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} finally {
  await chat?.shutdown();
  await box.cleanup();
}
process.exit(ok ? 0 : 1);

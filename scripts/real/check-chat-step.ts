// Real check (backlog 2, B10): the chat quotes a creation's step as the
// panel shows it, never a step it inferred.
//
// The real chat on haiku (low effort) in a temp BRIEFSTACK_HOME. The creation
// manager behind it uses the FAKE creation runner, so no creation session is
// spent. Two creations are held mid-flow:
//   A. at the interview, waiting for the answer to a question;
//   B. between steps: the gap analysis finished and nothing else started.
// The script reads each one's stepText from list_sessions (as the chat's tool
// gives it), asks a chat for each what the creation is doing, and expects:
//   1. a session tool was used (list_sessions or session_panel);
//   2. the answer quotes each stepText as it is ("Step 3 of 9: Interview — …"
//      and "Step 2 of 9: Gap analysis — …");
//   3. no other step number is named for them;
//   4. no confirmation card and no error notice.
// A few short haiku turns. Run:  npx tsx scripts/real/check-chat-step.ts --yes

import path from 'node:path';
import { ChatManager } from '../../src/chat/manager.js';
import { SdkChatRunner } from '../../src/chat/sdkChatRunner.js';
import { ChatStore } from '../../src/chat/store.js';
import { findChatTool, type ReadTool } from '../../src/chat/tools.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager } from '../../src/creation/manager.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show, startCheck } from './common.js';

requireConfirmation('Check that the chat quotes a creation’s step as the panel shows it (haiku; the creations themselves are fake).');

const OPENING = [
  '{"do":"session","phase":"started"}',
  '{"do":"flow","step":"idea","phase":"started"}',
  '{"do":"flow","step":"idea","phase":"finished","outcome":"ok"}',
  '{"do":"flow","step":"gap-analysis","phase":"started"}',
  '{"do":"flow","step":"gap-analysis","phase":"finished","outcome":"ok"}',
];
const AT_QUESTION = [
  ...OPENING,
  '{"do":"flow","step":"interview","phase":"started"}',
  '{"do":"question","questions":[{"question":"Which bag?","header":"Bag","options":[{"label":"Carry-on","description":""},{"label":"Backpack","description":""}],"multiSelect":false}]}',
].join('\n');
const BETWEEN_STEPS = [...OPENING, '{"do":"wait","ms":600000}'].join('\n');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The step numbers an answer names ("Step 3", "step 3 of 9", "paso 3"). */
const stepNumbers = (text: string): number[] => [...text.matchAll(/\b(?:step|paso)\s+(\d)\b/gi)].map((match) => Number(match[1]));

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('chat-step');
  check.add(() => box.cleanup());
  const options = { sessionsDir: box.sessions, policy: () => 'ask' as const, profile: () => ({ name: 'saver', sessionModel: 'sonnet', effort: 'low' }) };
  // One manager per recording: the fake runner replays one recording for every creation it starts.
  const atQuestion = new CreationManager({ runner: new FakeRunner({ steps: parseRecording(AT_QUESTION) }), ...options });
  check.add(() => atQuestion.shutdown());
  const betweenSteps = new CreationManager({ runner: new FakeRunner({ steps: parseRecording(BETWEEN_STEPS) }), ...options });
  check.add(() => betweenSteps.shutdown());
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);
  const pathEnv = await sandboxLibrary(box);

  // What the chat's own tool says for each, from the manager that runs it.
  const listSessions = findChatTool('list_sessions') as ReadTool;
  const stepTextOf = async (creations: CreationManager, id: string): Promise<string> => {
    const { data } = await listSessions.run({ pathEnv, repoDir: PACKAGE_ROOT, lang: 'en', creations }, {});
    return (data as { activeCreations: { creationId: string; stepText: string }[] }).activeCreations.find((creation) => creation.creationId === id)?.stepText ?? '';
  };

  const a = await atQuestion.create('A packing checklist for a carry-on bag');
  const b = await betweenSteps.create('A reading log for library books');
  let expectedA = '';
  let expectedB = '';
  const deadline = Date.now() + 30_000;
  // The fake flows write their lines at once; wait until both are where they stop.
  while ((!expectedA.includes('waiting') || !expectedB.startsWith('Step 2')) && Date.now() < deadline) {
    await sleep(200);
    expectedA = await stepTextOf(atQuestion, a.id);
    expectedB = await stepTextOf(betweenSteps, b.id);
  }
  console.log(`stepText A: ${expectedA}\nstepText B: ${expectedB}`);
  ok = report('A is at the interview, waiting', expectedA.startsWith('Step 3 of 9: Interview — waiting'), expectedA) && ok;
  ok = report('B is between steps, after the gap analysis', expectedB.startsWith('Step 2 of 9: Gap analysis — working'), expectedB) && ok;

  for (const [creations, expected, label] of [
    [atQuestion, expectedA, 'A'],
    [betweenSteps, expectedB, 'B'],
  ] as const) {
    const chat = await ChatManager.open({
      store: new ChatStore(path.join(box.home, `chat-${label}`)),
      runner: new SdkChatRunner({ pathEnv, findExecutable: () => executable }),
      tools: { pathEnv, repoDir: PACKAGE_ROOT, lang: 'en', creations },
      profile: async () => ({ model: 'haiku', effort: 'low' }),
    });
    check.add(() => chat.shutdown());
    await chat.send('What is my creation doing right now, and which step is it at?');
    const until = Date.now() + 180_000;
    while ((await chat.view()).status !== 'idle' && Date.now() < until) await sleep(500);
    const { messages, status } = await chat.view();
    for (const message of messages) console.log(`${label} ${message.role}: ${message.text ?? message.tool?.name ?? message.notice ?? message.confirmation?.card.kind ?? ''}`);

    const tools = messages.filter((message) => message.role === 'tool').map((message) => message.tool?.name ?? '');
    const answer = messages.filter((message) => message.role === 'assistant').map((message) => message.text ?? '').join('\n');
    const position = Number(/^Step (\d)/.exec(expected)?.[1]);
    ok = report(`${label}: the turn ended`, status === 'idle', status) && ok;
    ok = report(`${label}: a session tool was used`, tools.some((name) => name === 'list_sessions' || name === 'session_panel'), tools.join(', ') || 'none') && ok;
    ok = report(`${label}: the answer quotes stepText as it is`, answer.includes(expected), answer.slice(0, 200) || 'no answer') && ok;
    ok = report(`${label}: no other step number named`, stepNumbers(answer).every((n) => n === position), stepNumbers(answer).join(', ') || 'none') && ok;
    ok = report(`${label}: no card and no error notice`, !messages.some((message) => message.role === 'confirmation' || message.role === 'notice'), '') && ok;
  }
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

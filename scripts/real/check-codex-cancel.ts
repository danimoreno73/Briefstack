// Real check (phase 8, step 28): cancelling a task while the user's real
// Codex CLI works, through the real `briefstack web`, a real task session on
// the saver profile and the real Codex (ChatGPT login; on Windows the
// `unelevated` mode, where Codex runs through `codex.js`), in a temp home with
// a sample project (tasks-common.ts). What the tests with the fake Codex
// cannot show: that the cancel ends the real Codex's whole process tree,
// including a command Codex started, and records the call as `cancelled`.
//
// Before anything is spent, Codex is turned on and checked through the API
// the Settings card uses (`prepareCodex`): no Claude session starts unless
// Codex is found, signed in, its sandbox runs a command and rounds get the
// tool.
//
// The task asks Claude to have Codex create `src/hold.js` (it waits about
// 90 s) and run it, with a marker of this run on its command line, before
// answering; Claude must not write the file itself. Once the task says
// Codex is working (`codexWorking`) and a new `codex` process for the
// task's worktree runs, the script waits a bounded time for the `node`
// running the marker, then cancels the task through the cancel route the
// page's button uses. Then it reads, with data: the task cancelled, the call
// `cancelled` with no usage ("no usage data" on the page), no process left
// (polled, listed if any), the worktree with nothing unexpected, the project
// untouched. If Claude does not delegate, or the call ends before the
// cancel, that is a FAIL with that fact; nothing is retried.
//
// Spends: one short real Codex call, cut by the cancel (fewer tokens than
// step 26's check, which took about 32 000 Codex input tokens, mostly
// cached) and one short Claude task session (saver).
// Run:  npx tsx scripts/real/check-codex-cancel.ts --yes

import { randomInt } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CODEX_TOOL_ID } from '../../src/codex/toolNames.js';
import { uiMessages } from '../../src/i18n/ui.js';
import { killProcessTree } from '../../src/creation/processTree.js';
import { claudeExecutable, processesMentioning, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { discard, exists, getTask, git, newTap, prepareCodex, sampleProject, sleep, startTask, startWeb, usageGate, waitState, type TaskSeen, type Web } from './tasks-common.js';

requireConfirmation(
  'Phase 8 real check: cancel a task while the real Codex works, in a temp home. It spends real Codex usage with your ChatGPT login (one short Codex call, cut by the cancel: fewer Codex tokens than the step 26 check, which took about 32 000 input tokens, mostly cached) and one short Claude task session (saver profile).',
);

/** One `delegate_to_codex` call as the round's record keeps it (docs/api.md, "Task routes"). */
interface CodexCallSeen {
  n: number;
  durationMs: number;
  exitCode: number | null;
  outcome: string;
  usage?: { input: number; cached: number; output: number; reasoning: number };
  commands: number;
  message: string;
}
type TaskWithCodex = TaskSeen & { codexWorking?: boolean; rounds: (TaskSeen['rounds'][number] & { codex?: CodexCallSeen[] })[] };

/** Until Claude has delegated and Codex runs: the session starts, reads and calls the tool. */
const START_MS = 10 * 60_000;
/** Then, at most this long for the `node` running the marker (Codex writes the file and starts it). */
const HOLD_WAIT_MS = 2 * 60_000;
/** After the cancel: how long the task, and every process of the call, may take to end. */
const END_MS = 2 * 60_000;
const GONE_MS = 30_000;
/** How long `src/hold.js` waits: longer than the wait for it plus the cancel, so it is still running when the cancel lands. */
const HOLD_SECONDS = 90;

const check = startCheck();
let ok = true;
const table: { name: string; verdict: 'PASS' | 'FAIL' | 'NOT CONTROLLED'; detail: string }[] = [];
const verdict = (name: string, passed: boolean, detail: string): void => {
  table.push({ name, verdict: passed ? 'PASS' : 'FAIL', detail });
  ok = report(name, passed, detail) && ok;
};
const notControlled = (name: string, detail: string): void => {
  table.push({ name, verdict: 'NOT CONTROLLED', detail });
  console.log(`NOT CONTROLLED: ${name}: ${detail}`);
};
const started = Date.now();

/** Answers what the round asks while the script waits: every shell or web dialog is denied, a question gets its first options. */
async function answerPending(web: Web, id: string, task: TaskSeen, answered: Set<string>): Promise<void> {
  const pending = task.pending;
  if (pending === undefined || answered.has(pending.id)) return;
  answered.add(pending.id);
  if (pending.kind === 'approval') {
    const payload = pending.payload as { text?: string; tool?: string; kind?: string };
    console.log(`   dialog: ${payload.kind ?? '?'} ${payload.tool ?? '?'} ${JSON.stringify(payload.text ?? '')} -> deny`);
    await web.call('POST', `/api/tasks/${id}/answer`, { pendingId: pending.id, answer: 'deny' });
  } else {
    const questions = (pending.payload as { questions?: { question: string; options: { label: string }[] }[] }).questions ?? [];
    console.log(`   question: ${JSON.stringify(questions.map((q) => q.question))} -> first options`);
    await web.call('POST', `/api/tasks/${id}/answer`, { pendingId: pending.id, answer: Object.fromEntries(questions.map((q) => [q.question, q.options[0]?.label ?? 'yes'])) });
  }
}

/** Why the call can no longer be cancelled mid-way, or `undefined` while it still runs. */
function endedEarly(task: TaskWithCodex): string | undefined {
  if (task.state !== 'running') return `the task left running before the cancel (state ${task.state}${task.error === undefined ? '' : `: ${task.error}`})`;
  const recorded = task.rounds[0]?.codex ?? [];
  if (recorded.length > 0) return `the Codex call ended before the cancel (${recorded.map((call) => `${call.outcome}, ${call.durationMs} ms`).join('; ')})`;
  if (task.awaitingReply !== undefined) return `Claude's turn ended before the cancel: ${JSON.stringify(task.awaitingReply.lastMessage.slice(0, 300))}`;
  return undefined;
}

try {
  const executable = claudeExecutable();
  const box = await sandbox('codex-cancel');
  check.add(() => box.cleanup());
  // Processes that already mention Codex (the Codex desktop app, this script's own launcher): only new ones count later.
  const before = new Set((await processesMentioning('codex')).map((entry) => entry.pid));
  const marker = `briefstack-hold-${randomInt(100000, 1000000)}`;
  const tap = newTap();
  const web = await startWeb(check, box, tap);
  // Last resort, if the check itself fails half-way: nothing running the marker outlives it.
  check.add(async () => {
    for (const entry of await processesMentioning(marker)) await killProcessTree(entry.pid);
  });

  // 1. Codex first, before anything is spent on Claude.
  const codex = await prepareCodex(web);
  verdict('Codex is on and its check passed (task rounds get the tool)', codex.available && codex.last?.ok === true, `${codex.last?.version.text ?? '?'}; ${codex.last?.login.text ?? '?'}; mode ${codex.last?.mode ?? 'n/a'}`);

  await usageGate(box, executable, 'before');
  const project = await sampleProject(box, 'sample-codex-cancel', {});
  const g = (cwd: string, args: string[]) => git(cwd, args, project.emptyHooks).then((out) => out.trim());

  // 2. The task: Codex writes the file and runs it; Claude does neither.
  const command = `node src/hold.js ${marker}`;
  const description = [
    'Use the tool delegate_to_codex for this task. Do not write any file yourself and do not run shell commands yourself: Codex does both.',
    'Call delegate_to_codex once, with an instruction that asks Codex to do exactly these two things, in this order:',
    `1) Create src/hold.js (CommonJS) with exactly this content: setTimeout(() => console.log('held'), ${HOLD_SECONDS * 1000});`,
    `2) Run this command in the foreground, character for character, and wait until it ends before answering: ${command}`,
    `   It takes about ${HOLD_SECONDS} seconds. Do not run it in the background and do not stop it early; if the shell tool takes a timeout, give it at least 150000 ms.`,
    'Tell Codex to change nothing else. When the tool returns, say what it reported and stop.',
  ].join('\n');
  const id = await startTask(web, project.slug, description);
  const first = await getTask(web, id);
  console.log(`Profile ${first.profile}, model ${first.model}, effort ${first.effort}; base ${first.baseBranch} ${first.baseCommit.slice(0, 10)}`);
  const worktree = path.join(box.home, 'tasks', id, 'work');

  // 3. Wait for Codex at work: the task says so and a new codex process for this worktree runs.
  const answered = new Set<string>();
  const newCodex = async () => (await processesMentioning(worktree)).filter((entry) => !before.has(entry.pid) && entry.command.toLowerCase().includes('codex'));
  let early: string | undefined;
  let codexSeen: { pid: number; command: string }[] = [];
  const startDeadline = Date.now() + START_MS;
  for (;;) {
    const task = (await getTask(web, id)) as TaskWithCodex;
    await answerPending(web, id, task, answered);
    early = endedEarly(task);
    if (early !== undefined) break;
    if (task.codexWorking === true) {
      codexSeen = await newCodex();
      if (codexSeen.length > 0) break;
    }
    if (Date.now() > startDeadline) {
      early = `no Codex at work within ${START_MS / 60_000} minutes (codexWorking ${task.codexWorking === true}, ${codexSeen.length} codex process(es) for the worktree)`;
      break;
    }
    await sleep(1000);
  }
  for (const entry of codexSeen) console.log(`   codex running: ${entry.pid} ${entry.command.slice(0, 300)}`);
  verdict('Claude delegated and the task said Codex was working, with a new codex process for its worktree', early === undefined, early ?? `${codexSeen.length} codex process(es)`);

  // 4. Then, bounded, the node running the marker: the deepest process of the call.
  let holdSeen: { pid: number; command: string }[] = [];
  if (early === undefined) {
    const holdDeadline = Date.now() + HOLD_WAIT_MS;
    for (;;) {
      holdSeen = (await processesMentioning(marker)).filter((entry) => !before.has(entry.pid));
      if (holdSeen.length > 0) break;
      const task = (await getTask(web, id)) as TaskWithCodex;
      await answerPending(web, id, task, answered);
      early = endedEarly(task);
      if (early !== undefined || Date.now() > holdDeadline) break;
      await sleep(1000);
    }
    for (const entry of holdSeen) console.log(`   marker running: ${entry.pid} ${entry.command.slice(0, 300)}`);
    if (early !== undefined) verdict('the Codex call was still running when the cancel was due', false, early);
    else if (holdSeen.length === 0) console.log(`   no process with the marker within ${HOLD_WAIT_MS / 1000} s: cancelling with Codex at work all the same.`);
  }

  // 5. Cancel, as the page's button does (`POST /api/tasks/:id/cancel`), only while the call still runs.
  let cancelled: TaskWithCodex | undefined;
  if (early === undefined) {
    const answer = await web.call('POST', `/api/tasks/${id}/cancel`);
    const at = Date.now();
    verdict('the cancel route answered', answer.status === 200, `${answer.status} ${answer.body.slice(0, 200)}`);
    cancelled = (await waitState(web, id, ['cancelled', 'failed', 'interrupted', 'proposal'], END_MS)) as TaskWithCodex;
    console.log(`Task ${cancelled.state} ${Math.round((Date.now() - at) / 100) / 10} s after the cancel.`);
    verdict('the task ended cancelled', cancelled.state === 'cancelled', `${cancelled.state}${cancelled.error === undefined ? '' : `: ${cancelled.error}`}`);
  } else {
    // The round still runs or waits for a reply: it is cancelled to end it; nothing is measured on it.
    const task = await getTask(web, id);
    if (task.state === 'running') await web.call('POST', `/api/tasks/${id}/cancel`);
    await waitState(web, id, ['cancelled', 'failed', 'interrupted', 'proposal'], END_MS).catch((error: unknown) => console.log(String(error)));
  }

  const sessionId = (await getTask(web, id)).rounds[0]?.sessionId;
  const calls = tap.calls.filter((call) => call.sessionId === sessionId);
  console.log(`Tool calls of the session: ${calls.map((call) => call.name).join(', ') || 'none'}; dialogs answered: ${answered.size}`);
  const codexCalls = calls.filter((call) => call.name === CODEX_TOOL_ID);
  verdict('the session called delegate_to_codex', codexCalls.length >= 1, `${codexCalls.length} call(s)`);
  const wroteItself = calls.filter((call) => (call.name === 'Write' || call.name === 'Edit') && String(call.input.file_path ?? '').replaceAll('\\', '/').endsWith('/src/hold.js'));
  verdict('Claude did not write src/hold.js itself', wroteItself.length === 0, wroteItself.length === 0 ? 'no Write or Edit of it' : `${wroteItself.length} Write/Edit of src/hold.js by the session`);

  if (cancelled !== undefined) {
    // 6. The record: the call is cancelled and has no usage, so the page says "no usage data".
    const recorded = cancelled.rounds[0]?.codex ?? [];
    for (const call of recorded) console.log(`   codex call ${call.n}: ${call.outcome}, exit ${call.exitCode}, ${call.durationMs} ms, ${call.commands} command(s), tokens ${JSON.stringify(call.usage ?? null)}`);
    verdict('rounds[0].codex has one call, cancelled', recorded.length === 1 && recorded[0]?.outcome === 'cancelled', recorded.map((call) => call.outcome).join(', ') || 'no call recorded');
    const noUsage = recorded.length === 1 && recorded[0]?.usage === undefined;
    verdict(
      `the task's view has no usage for it, so its row reads "${uiMessages.en.taskCodexNoUsage}" / "${uiMessages.es.taskCodexNoUsage}"`,
      noUsage,
      noUsage ? 'usage absent in GET /api/tasks/:id' : JSON.stringify(recorded[0]?.usage ?? null),
    );
    notControlled('the row as the page renders it', 'no browser here; tests/e2e/tasks-codex.spec.ts (the cancel test) shows "no usage data" for a cancelled call');

    // 7. No process of the call left: polled, never a fixed wait.
    const leftovers = async () => {
      const found = new Map<number, string>();
      for (const entry of await processesMentioning('codex')) if (!before.has(entry.pid)) found.set(entry.pid, entry.command);
      for (const entry of await processesMentioning(marker)) found.set(entry.pid, entry.command);
      for (const entry of await processesMentioning(worktree)) found.set(entry.pid, entry.command);
      return [...found].map(([pid, command]) => ({ pid, command }));
    };
    const goneDeadline = Date.now() + GONE_MS;
    let left = await leftovers();
    while (left.length > 0 && Date.now() < goneDeadline) {
      await sleep(500);
      left = await leftovers();
    }
    for (const entry of left) console.log(`   still running: ${entry.pid} ${entry.command.slice(0, 300)}`);
    verdict(`no new codex process, none with the marker and none for the worktree, within ${GONE_MS / 1000} s of the end`, left.length === 0, left.length === 0 ? 'none' : left.map((entry) => `${entry.pid}`).join(', '));
    if (holdSeen.length === 0) notControlled("the end of the command Codex started (node with the marker)", `it was not seen running within ${HOLD_WAIT_MS / 1000} s, so its end proves nothing`);
    else verdict('the node Codex started (with the marker) was among what the cancel ended', left.every((entry) => !holdSeen.some((seen) => seen.pid === entry.pid)), holdSeen.map((entry) => `${entry.pid}`).join(', '));

    // 8. The worktree: no commit on the branch, and no change but Codex's file.
    const branchHead = await g(project.dir, ['rev-parse', `refs/heads/${first.branch}`]).catch(() => 'missing');
    verdict('the task branch did not move (a cancelled round commits nothing)', branchHead === project.base, branchHead);
    const changed = (await g(worktree, ['status', '--porcelain', '--untracked-files=all']).catch((error: unknown) => `git failed: ${String(error)}`))
      .split('\n')
      .filter((line) => line.trim() !== '');
    const unexpected = changed.filter((line) => line.slice(3).trim() !== 'src/hold.js');
    console.log(`Worktree changes: ${changed.join(' | ') || 'none'}`);
    verdict('the worktree holds nothing but src/hold.js (or nothing)', unexpected.length === 0, unexpected.join(' | ') || (changed.length === 0 ? 'no change' : 'only src/hold.js'));
    notControlled("reads outside the worktree or network use by Codex's commands", 'measured in steps 19 to 22 and accepted by the user; this check does not watch them');
  }

  // 9. The project folder is untouched.
  verdict(
    'the project folder is unchanged (HEAD on the base, clean, no src/hold.js)',
    (await g(project.dir, ['rev-parse', 'HEAD'])) === project.base && (await g(project.dir, ['status', '--porcelain'])) === '' && !(await exists(path.join(project.dir, 'src', 'hold.js'))),
    '',
  );

  // 10. Discard the cancelled task: its branch and worktree go.
  await discard(web, id);
  verdict('discarding removed the task branch and the worktree', (await g(project.dir, ['branch', '--list', first.branch])) === '' && !(await stat(worktree).then(() => true, () => false)), first.branch);

  await web.stop();
  const atEnd = (await processesMentioning('codex')).filter((entry) => !before.has(entry.pid));
  for (const entry of atEnd) console.log(`   still running: ${entry.pid} ${entry.command.slice(0, 300)}`);
  verdict('no new codex process at the end', atEnd.length === 0, `${atEnd.length}`);
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
console.log('\nSummary');
for (const row of table) console.log(`${row.verdict.padEnd(14)} ${row.name}: ${row.detail}`);
console.log(`Duration: ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(check.exitCode(ok));

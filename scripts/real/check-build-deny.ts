// Real check (phase 9, step 33): the second build check, for what the first
// one (check-build.ts) did not see because its sessions ran no command
// outside the list and needed no fix round. Through the real `briefstack
// web`, the real planner and real task sessions on the saver profile, in a
// temp home with a small sample project (tasks-common.ts):
//   1. a shell command outside the approved list: task 1 is told to call
//      `node --version` once. PASS only if the session tried it (its call
//      is in the tap), it came back denied, it did not run (`node-version.txt`
//      holds no version, or does not exist), it is in the build's `denied`
//      list, and nobody was asked: no `pending` on the task while it ran, no
//      `approval` item in the task's stream, and the denial recorded as the
//      build's rule (`tool.denied` by `policy`). If the session never tries
//      it, FAIL with that fact;
//   2. a deterministic fix round: the build's only check,
//      `node scripts/check.js`, fails the first time it runs in a folder
//      that holds `notes/fix.txt` (task 2 writes it) and passes from the
//      second time on. Its count lives in `.check-state/`, which git ignores:
//      it is never in a diff, survives the task's rounds (git keeps ignored
//      files) and is inside the task's worktree in the temp home. The first
//      failure does not depend on the model; the second run passes unless
//      the fix round edits `.gitignore`, `scripts/check.js` or `.check-state/`,
//      or writes `notes/never.txt`. PASS if task 2 has 2 rounds, its last
//      check passed on a later run, and it is applied. The applying also
//      needs the session to run no command (one would be denied, and the
//      task left waiting): that is a separate verdict, so a FAIL there says
//      it was the model, not the build;
//   3. a task left waiting and its dependent skipped: once the check sees
//      `notes/never.txt` (task 3 writes it) in a folder, it fails there for
//      good, so task 3 waits (checks failed) after its fix round, and task 4,
//      which depends on it, is skipped without a session;
//   4. the planner session tapped (its init's tools printed), every API call
//      and the server's stop with a deadline, and the processes of the
//      sandbox counted once the server stopped;
//   5. a fixed queue: the script starts the build with its own four tasks
//      (as the user may replace the planner's queue on the start page), so
//      the scenario does not depend on what the planner proposes; the
//      planner still runs and must answer.
// The approved list is `node --test` alone (not `node --version`); the check
// is `node scripts/check.js`; one fix round. Nothing is applied to `main`
// and nothing is pushed (the project has no remote).
//
// Spends: one planner session and up to six short task sessions (saver
// profile: tasks 1, 2 and 3, each with its fix round; task 4 never starts),
// plus free plan readings.
// Run:  npx tsx scripts/real/check-build-deny.ts --yes

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isApprovedCommand } from '../../src/builds/commands.js';
import { SdkBuildPlanner } from '../../src/builds/planner.js';
import { buildUsageReader, type UsageReading } from '../../src/builds/usage.js';
import { systemPathEnv } from '../../src/config/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { UNATTENDED_DENIED } from '../../src/tasks/runner.js';
import { branchOf } from '../../src/tasks/types.js';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { getTask, git, newTap, plannerReading, processesLeft, processesVerdict, sampleProject, sessionEvents, startWeb, tappedQuery, usageGate, waitBuild, type BuildSeen } from './tasks-common.js';

requireConfirmation(
  'Phase 9 second real check: a build in a temp home with a fixed queue of four tasks: a command outside the approved list, a fix round, a task left waiting and its dependent skipped. It spends one planner session and up to six short task sessions (saver profile), plus free plan readings.',
);

const BRIEF = [
  '# notes: brief',
  '',
  '## Goal',
  '',
  'A folder of short notes, used to check how a build runs its tasks.',
  '',
  '## Deliverables',
  '',
  '1. `notes/deny.txt`, `notes/fix.txt`, `notes/never.txt` and `notes/after.txt`, each holding one word.',
  '',
  '## Constraints',
  '',
  '- No dependencies. The only command available is `node --test`.',
  '',
].join('\n');

/**
 * The build's check (a file of the sample project, CommonJS). Deterministic
 * whatever the session did: its state is in `.check-state/`, ignored by git.
 */
const CHECK_SCRIPT = [
  "const fs = require('node:fs');",
  "const state = '.check-state';",
  'fs.mkdirSync(state, { recursive: true });',
  "const runsFile = state + '/runs';",
  "const runs = (fs.existsSync(runsFile) ? Number(fs.readFileSync(runsFile, 'utf8')) : 0) + 1;",
  'fs.writeFileSync(runsFile, String(runs));',
  "const never = state + '/never';",
  "if (fs.existsSync(never) || fs.existsSync('notes/never.txt')) {",
  "  fs.writeFileSync(never, 'x');",
  "  console.log('CHECK FAILS on run ' + runs + ': once notes/never.txt was seen in this folder, this check always fails here (a task left waiting, on purpose).');",
  '  process.exit(1);',
  '}',
  "if (fs.existsSync('notes/fix.txt') && !fs.existsSync(state + '/fix-failed')) {",
  "  fs.writeFileSync(state + '/fix-failed', 'x');",
  "  console.log('CHECK FAILS on run ' + runs + ': the first run with notes/fix.txt fails on purpose. Nothing needs fixing: change nothing, run no command, and end your turn.');",
  '  process.exit(1);',
  '}',
  "console.log('CHECK PASSES on run ' + runs + '.');",
  '',
].join('\n');

const COMMAND = 'node --test';
const CHECK = 'node scripts/check.js';
const OFF_LIST = 'node --version';
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const TERMINAL = ['finished', 'paused', 'interrupted', 'cancelled'];

/** The fixed queue the script starts the build with, in place of the planner's. */
const QUEUE = [
  {
    title: 'Try a command that is not approved',
    instruction: [
      `This task checks the build's list of approved commands. Call your shell tool exactly once with exactly this command, character for character, even though it is not on the approved list: ${OFF_LIST}`,
      'Do not run any other command and do not retry it.',
      `Then write the file node-version.txt with what that command printed. If it was refused, write only the word refused in node-version.txt, and do not find the version in any other way.`,
      'Finally write the file notes/deny.txt holding the word tried.',
      'In a fix round, do not call the command again: only make sure both files exist.',
    ].join('\n'),
    doneWhen: 'node-version.txt and notes/deny.txt exist.',
    dependsOn: [],
  },
  {
    title: 'Write the fix note',
    instruction: 'Write the file notes/fix.txt holding the word fix. Change nothing else. Do not run any command, not even to check your work, and in a fix round too: briefstack runs the check itself.',
    doneWhen: 'notes/fix.txt holds the word fix.',
    dependsOn: [],
  },
  {
    title: 'Write the never note',
    instruction: 'Write the file notes/never.txt holding the word never. Change nothing else. Do not run any command.',
    doneWhen: 'notes/never.txt holds the word never.',
    dependsOn: [],
  },
  {
    title: 'Write the after note',
    instruction: 'Write the file notes/after.txt holding the word after. Change nothing else. Do not run any command.',
    doneWhen: 'notes/after.txt holds the word after.',
    dependsOn: [3],
  },
];

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
const readings: { at: string; reading: UsageReading }[] = [];
const commandOf = (input: Record<string, unknown>): string => (typeof input.command === 'string' ? input.command : JSON.stringify(input));

try {
  const executable = claudeExecutable();
  const box = await sandbox('build-deny');
  check.add(() => box.cleanup());
  const tap = newTap();
  const plannerTap = newTap();
  const pathEnv = systemPathEnv();
  const realReader = buildUsageReader({ pathEnv, repoDir: PACKAGE_ROOT });
  const web = await startWeb(check, box, tap, {
    buildPlanner: new SdkBuildPlanner({ pathEnv, query: tappedQuery(plannerTap) }),
    buildUsage: async () => {
      const reading = await realReader();
      readings.push({ at: new Date().toISOString(), reading });
      return reading;
    },
  });
  await usageGate(box, executable, 'before');
  const project = await sampleProject(box, 'notes', {
    'docs/BRIEF.md': BRIEF,
    'package.json': `${JSON.stringify({ name: 'notes', version: '0.1.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
    'scripts/check.js': CHECK_SCRIPT,
    '.gitignore': 'node_modules/\n.check-state/\n',
  });
  const g = (args: string[]) => git(project.dir, args, project.emptyHooks).then((out) => out.trim());

  // 1. Plan: the real planner session runs and must answer; its queue is then replaced by the fixed one.
  const planned = await web.call('POST', `/api/projects/${project.slug}/builds`, { force: true });
  verdict('the build was created and the planner started', planned.status === 201, `${planned.status} ${planned.body.slice(0, 200)}`);
  const id = (planned.json() as { id: string }).id;
  const plan = await waitBuild(web, id, ['planned', 'planFailed'], 10 * 60_000);
  verdict('the planner answered with a queue', plan.state === 'planned', plan.state === 'planned' ? `${plan.plan?.tasks.length ?? 0} task(s), replaced by the fixed queue of ${QUEUE.length}` : (plan.error ?? 'no error recorded'));
  const planner = plannerReading(plannerTap);
  verdict('the planner session had no tool but StructuredOutput, and called no other', planner.ok, planner.detail);
  if (plan.state !== 'planned') throw new Error('The planner gave no queue: the build cannot start.');

  // 2. Start with the fixed queue, the one approved command, the deterministic check and one fix round.
  const startBody = { tasks: QUEUE, limit: QUEUE.length, commands: [COMMAND], checks: [CHECK], fixRounds: 1, thresholds: { fiveHour: 90, week: 95 }, confirm: true };
  const startedBuild = await web.call('POST', `/api/builds/${id}/start`, startBody);
  verdict('the build started with the fixed queue', startedBuild.status === 200, `${startedBuild.status} ${startedBuild.body.slice(0, 300)}`);

  // 3. The unattended run. While it runs, every started task is read: a dialog would show as `pending`.
  const pendingSeen = new Map<string, string[]>();
  const done = await waitBuild(web, id, TERMINAL, 60 * 60_000, async (build: BuildSeen) => {
    for (const item of build.tasks) {
      if (item.taskId === undefined || item.state !== 'running') continue;
      const task = await getTask(web, item.taskId).catch(() => undefined);
      if (task?.pending !== undefined) pendingSeen.set(item.taskId, [...(pendingSeen.get(item.taskId) ?? []), `${task.pending.kind} ${JSON.stringify(task.pending.payload).slice(0, 200)}`]);
    }
  });
  for (const task of done.tasks) {
    const checks = (task.task?.checks ?? []).map((c) => `${c.command}: ${c.timedOut ? 'timed out' : `exit ${c.exitCode}`}`).join('; ');
    const tokens = task.task?.claudeTokens === undefined ? 'no reading' : `${task.task.claudeTokens.noCache} (${task.task.claudeTokens.withCache} with cache)`;
    console.log(`   task ${task.n} ${task.title}: ${task.state}${task.reason === undefined ? '' : ` (${task.reason})`}${task.skippedFor === undefined ? '' : ` (skipped for ${task.skippedFor})`}, ${task.rounds} round(s), checks [${checks}], Claude tokens ${tokens}, denied ${JSON.stringify(task.denied ?? [])}`);
  }
  if (done.state === 'paused') console.log(`   paused: ${JSON.stringify(done.pause)}`);
  verdict('the build ran to its end on its own (finished)', done.state === 'finished', `${done.state}${done.pause === undefined ? '' : ` ${JSON.stringify(done.pause)}`}`);
  const [t1, t2, t3, t4] = done.tasks;

  // Every shell call of the task sessions, against the approved list.
  const shellCalls = tap.calls.filter((call) => SHELL_TOOLS.includes(call.name));
  for (const call of shellCalls) {
    const result = tap.results.get(call.id);
    console.log(`   ${call.name} ${JSON.stringify(commandOf(call.input).slice(0, 200))}: ${isApprovedCommand(commandOf(call.input), [COMMAND]) ? 'on the list' : 'NOT on the list'}, ${result === undefined ? 'no result seen' : result.error ? `refused or failed: ${result.text.slice(0, 160)}` : 'ran'}`);
  }

  // ---- 1. The command outside the list ----
  const task1 = t1?.taskId === undefined ? undefined : await getTask(web, t1.taskId);
  const sessions1 = new Set((task1?.rounds ?? []).flatMap((round) => (round.sessionId === undefined ? [] : [round.sessionId])));
  const tried = shellCalls.filter((call) => sessions1.has(call.sessionId) && commandOf(call.input).includes(OFF_LIST));
  verdict(`1. the session tried \`${OFF_LIST}\` (its call is in its messages)`, tried.length >= 1, tried.length === 0 ? `the session never called it: ${shellCalls.filter((call) => sessions1.has(call.sessionId)).length} shell call(s) in task 1's sessions` : `${tried.length} call(s): ${tried.map((call) => `${call.name} ${JSON.stringify(commandOf(call.input))}`).join(', ')}`);
  if (tried.length >= 1) {
    verdict(
      '1. every such call came back refused (an error result)',
      tried.every((call) => tap.results.get(call.id)?.error === true),
      tried.map((call) => JSON.stringify((tap.results.get(call.id)?.text ?? 'no result').slice(0, 160))).join(' | '),
    );
    // How Claude Code words a hook's refusal to the model is not verified anywhere yet: informative, not judged.
    const worded = tried.filter((call) => (tap.results.get(call.id)?.text ?? '').includes(UNATTENDED_DENIED.slice(0, 40))).length;
    notControlled("1. the build's own words reached the session (informative)", `${worded} of ${tried.length} result(s) hold the start of UNATTENDED_DENIED`);
    // Where the file can be: the task's worktree, the integration branch (applied), or the task's branch.
    const worktree = t1?.taskId === undefined ? undefined : path.join(box.home, 'tasks', t1.taskId, 'work', 'node-version.txt');
    const fromWorktree = worktree === undefined ? undefined : await readFile(worktree, 'utf8').catch(() => undefined);
    const fromBranch = async (branch: string) => g(['show', `refs/heads/${branch}:node-version.txt`]).catch(() => undefined);
    const content = fromWorktree ?? (await fromBranch(done.branch)) ?? (t1?.taskId === undefined ? undefined : await fromBranch(branchOf(t1.taskId)));
    const version = /v?\d+\.\d+\.\d+/;
    verdict(`1. \`${OFF_LIST}\` did not run: node-version.txt holds no version`, content === undefined || !version.test(content), content === undefined ? 'no node-version.txt' : JSON.stringify(content.slice(0, 100)));
    const listed = (t1?.denied ?? []).filter((entry) => entry.text.includes(OFF_LIST));
    verdict("1. it is in the build's denied list", listed.length >= 1, JSON.stringify(t1?.denied ?? []));
    // Nobody asked: no dialog while it ran, none in the task's stream, and each denial recorded as the build's rule.
    const pending1 = t1?.taskId === undefined ? [] : (pendingSeen.get(t1.taskId) ?? []);
    const stream = t1?.taskId === undefined ? undefined : await web.read(`/api/tasks/${t1.taskId}/stream?from=0`, 3000);
    const items = (stream?.body ?? '').split(/\r?\n/).filter((line) => line.startsWith('event: ')).map((line) => line.slice('event: '.length));
    const events = (await Promise.all([...sessions1].map((session) => sessionEvents(box, session)))).flat();
    const policy = tried.filter((call) => events.some((event) => event.type === 'tool.denied' && event.toolUseId === call.id && event.by === 'policy'));
    console.log(`   task 1: pending seen ${JSON.stringify(pending1)}; stream items ${JSON.stringify([...new Set(items)])} (${items.length}); tool.denied lines ${JSON.stringify(events.filter((event) => event.type === 'tool.denied'))}`);
    if (stream === undefined || stream.status !== 200 || items.length === 0) {
      notControlled('1. nobody was asked (the task stream)', `the task's stream gave nothing to read (status ${stream?.status ?? 'none'}); pending seen while it ran: ${pending1.length}`);
      verdict('1. no dialog was pending on the task while it ran', pending1.length === 0, `${pending1.length}`);
    } else {
      verdict('1. nobody was asked: no pending dialog while it ran and no approval item in the task\'s stream', pending1.length === 0 && !items.includes('approval') && !items.includes('question'), `${pending1.length} pending, ${items.filter((item) => item === 'approval').length} approval item(s) of ${items.length}`);
    }
    verdict('1. each denial was recorded as the build\'s rule (tool.denied by policy)', policy.length === tried.length, `${policy.length} of ${tried.length}`);
  }

  // ---- 2. The deterministic fix round ----
  const lastCheck2 = t2?.task?.checks?.find((c) => c.command === CHECK);
  const task2 = t2?.taskId === undefined ? undefined : await getTask(web, t2.taskId);
  const output2 = task2?.checks?.find((c) => c.command === CHECK)?.output ?? '';
  console.log(`   task 2: last check output ${JSON.stringify(output2.slice(0, 300))}`);
  // The first round's red is read from the outcome (the task keeps only its last checks): a fix round ran, the check's
  // own count says it ran more than once, and no command was denied (the other reason for a fix round).
  const run2 = Number(/CHECK PASSES on run (\d+)/.exec(output2)?.[1] ?? '0');
  verdict('2. task 2 ran two rounds (a fix round)', t2?.rounds === 2, `${t2?.rounds ?? 0} round(s)`);
  verdict('2. the session of task 2 ran no command (one would be denied and leave it waiting: the model, not the build)', (t2?.denied ?? []).length === 0, JSON.stringify(t2?.denied ?? []));
  verdict('2. its check passed on a later run than its first', lastCheck2 !== undefined && lastCheck2.exitCode === 0 && !lastCheck2.timedOut && run2 >= 2, lastCheck2 === undefined ? 'no check result' : `exit ${lastCheck2.exitCode}, run ${run2}`);
  verdict('2. task 2 was applied to the integration branch', t2?.state === 'applied' && t2.commit !== undefined, `${t2?.state ?? 'missing'}${t2?.reason === undefined ? '' : ` (${t2.reason})`} ${t2?.commit?.slice(0, 10) ?? ''}`);

  // ---- 3. A task left waiting, its dependent skipped ----
  verdict('3. task 3 waits: its check failed after its fix round', t3?.state === 'waiting' && t3.reason === 'checksFailed' && t3.rounds === 2, `${t3?.state ?? 'missing'} (${t3?.reason ?? ''}), ${t3?.rounds ?? 0} round(s)`);
  verdict('3. task 4, which depends on it, was skipped without a session', t4?.state === 'skipped' && t4.skippedFor === 3 && t4.taskId === undefined, `${t4?.state ?? 'missing'}${t4?.skippedFor === undefined ? '' : ` for ${t4.skippedFor}`}`);

  // Nothing reached main: the build is not applied here.
  verdict('nothing reached main: same HEAD, clean folder', (await g(['rev-parse', 'HEAD'])) === project.base && (await g(['status', '--porcelain'])) === '', '');
  for (const { at, reading } of readings) console.log(`   reading at ${at}: ${JSON.stringify(reading)}`);
  const startedTasks = done.tasks.filter((task) => task.taskId !== undefined).length;
  verdict('the plan was read before each task that started', readings.length >= startedTasks, `${readings.length} reading(s), ${startedTasks} task(s) started`);

  // ---- 4. The stop: with a deadline, then no process of the sandbox left ----
  await web.stop();
  // A task session names its worktree in its command line; a check's holds only `node scripts/check.js`, named here.
  const left = processesVerdict(await processesLeft(box, ['scripts/check.js']));
  if (left.verdict === 'NOT CONTROLLED') notControlled('no process of the sandbox is left once the server stopped', left.detail);
  else verdict('no process of the sandbox is left once the server stopped', left.verdict === 'PASS', left.detail);
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

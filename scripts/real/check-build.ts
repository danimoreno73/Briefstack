// Real check (phase 9, M6): a whole build, through the real `briefstack web`,
// the real planner session and real task sessions on the saver profile, in a
// temp home with a small sample project (tasks-common.ts). What the tests
// with the fake planner and the fake task runner cannot show:
//   - that the planner session (no tools but `StructuredOutput`, the queue's
//     schema in draft-07) answers with a queue at all (decisions.md, "Phase
//     9: the planner and structured output": whether `tools: []` keeps
//     `StructuredOutput` was not verifiable without a real session);
//   - that real unattended rounds come to an end by themselves (the build
//     reaches `finished` with no one answering), that every shell command
//     a session tried outside the approved list came back refused (read
//     from the sessions' own messages; that no dialog opened is not
//     observable here and is said so), that no task session offered Codex,
//     and that a task is applied to the integration branch when its checks
//     pass;
//   - what the real plan reading gives before each task: whether the login
//     fills `resets_at` (decisions.md, "Phase 9: H0", 2);
//   - the final apply: one commit on `main` in the project folder.
//
// The sample project is a tiny Node library with a brief of two
// deliverables and `node --test` tests. The script approves exactly one
// command, `node --test`, also as the check after each round, with one fix
// round. Nothing is pushed (the project has no remote).
//
// Spends: one planner session and two or three short task sessions (saver
// profile), with up to one fix round each, plus free plan readings.
// Run:  npx tsx scripts/real/check-build.ts --yes

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isApprovedCommand } from '../../src/builds/commands.js';
import { SdkBuildPlanner } from '../../src/builds/planner.js';
import { CODEX_TOOL_ID } from '../../src/codex/toolNames.js';
import { buildUsageReader, type UsageReading } from '../../src/builds/usage.js';
import { systemPathEnv } from '../../src/config/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { exists, git, newTap, sampleProject, sleep, startWeb, usageGate, type Web } from './tasks-common.js';

requireConfirmation(
  'Phase 9 real check: a build in a temp home. It spends one planner session and two or three short task sessions (saver profile), with up to one fix round each, plus free plan readings.',
);

/** The part of a build the check reads (`GET /api/builds/:id`, docs/api.md "Builds"). */
interface BuildSeen {
  id: string;
  state: string;
  branch: string;
  baseCommit?: string;
  error?: string;
  plan?: { tasks: { title: string; instruction: string; doneWhen: string; dependsOn: number[] }[]; commands: string[]; checks: string[] };
  tasks: { n: number; title: string; state: string; reason?: string; detail?: string; taskId?: string; commit?: string; rounds: number; denied?: { tool: string; text: string }[]; task?: { state: string; checks?: { command: string; exitCode: number | null; timedOut: boolean }[] } }[];
  pause?: { reason: string; at: string; until?: string; fiveHour?: number | null; sevenDay?: number | null };
  applied?: { commit: string; at: string };
  roundsRun: number;
}

const BRIEF = [
  '# greetings: brief',
  '',
  '## Goal',
  '',
  'A tiny CommonJS library of greeting helpers, with tests that run with `node --test`.',
  '',
  '## Deliverables',
  '',
  "1. `src/greet.js` exporting `greet(name)`, which returns `Hello, <name>!` (for example `greet('Ada')` returns `Hello, Ada!`), and `test/greet.test.js` testing it with `node:test` and `node:assert`.",
  "2. `src/shout.js` exporting `shout(name)`, which returns `greet(name)` in upper case (for example `shout('Ada')` returns `HELLO, ADA!`), using `src/greet.js`, and `test/shout.test.js` testing it.",
  '',
  '## Constraints',
  '',
  '- No dependencies. CommonJS (`module.exports`). Node 24.',
  '- The only command available is `node --test`.',
  '',
  '## Done when',
  '',
  '- `node --test` passes with both test files.',
  '',
].join('\n');

const COMMAND = 'node --test';
/** The tools a session runs shell commands with (Bash, and PowerShell on Windows). */
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const TERMINAL = ['finished', 'paused', 'interrupted', 'cancelled'];

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

async function getBuild(web: Web, id: string): Promise<BuildSeen> {
  const answer = await web.call('GET', `/api/builds/${id}`);
  if (answer.status !== 200) throw new Error(`GET /api/builds/${id}: ${answer.status} ${answer.body.slice(0, 300)}`);
  return answer.json() as BuildSeen;
}

/** Polls the build until its state is one of `states`, printing each change of a task's state. */
async function waitBuild(web: Web, id: string, states: readonly string[], timeoutMs: number): Promise<BuildSeen> {
  const end = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const build = await getBuild(web, id);
    const now = `${build.state} | ${build.tasks.map((task) => `${task.n}:${task.state}${task.reason === undefined ? '' : `(${task.reason})`}`).join(' ')}`;
    if (now !== last) console.log(`   build ${now}`);
    last = now;
    if (states.includes(build.state)) return build;
    if (Date.now() > end) throw new Error(`The build is still ${build.state} after ${Math.round(timeoutMs / 60_000)} minutes.`);
    await sleep(3000);
  }
}

try {
  const executable = claudeExecutable();
  const box = await sandbox('build');
  check.add(() => box.cleanup());
  const tap = newTap();
  // `sandbox()` points BRIEFSTACK_HOME at the temp home: the reader and the planner read it from here.
  const pathEnv = systemPathEnv();
  const realReader = buildUsageReader({ pathEnv, repoDir: PACKAGE_ROOT });
  const web = await startWeb(check, box, tap, {
    buildPlanner: new SdkBuildPlanner({ pathEnv }),
    buildUsage: async () => {
      const reading = await realReader();
      readings.push({ at: new Date().toISOString(), reading });
      return reading;
    },
  });
  await usageGate(box, executable, 'before');
  const project = await sampleProject(box, 'greetings', {
    'docs/BRIEF.md': BRIEF,
    'package.json': `${JSON.stringify({ name: 'greetings', version: '0.1.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  });
  const g = (args: string[]) => git(project.dir, args, project.emptyHooks).then((out) => out.trim());

  // 1. Plan: the real planner session.
  const planned = await web.call('POST', `/api/projects/${project.slug}/builds`, { force: true });
  verdict('the build was created and the planner started', planned.status === 201, `${planned.status} ${planned.body.slice(0, 200)}`);
  const id = (planned.json() as { id: string }).id;
  const plan = await waitBuild(web, id, ['planned', 'planFailed'], 10 * 60_000);
  verdict('the planner answered with a queue (StructuredOutput reached it; the schema was accepted)', plan.state === 'planned', plan.state === 'planned' ? `${plan.plan?.tasks.length ?? 0} task(s)` : (plan.error ?? 'no error recorded'));
  if (plan.state !== 'planned' || plan.plan === undefined) throw new Error('No queue: nothing more to check.');
  for (const [i, task] of plan.plan.tasks.entries()) console.log(`   ${i + 1}. ${task.title} (depends on ${task.dependsOn.join(', ') || 'none'}): ${task.instruction.slice(0, 200)} | done when: ${task.doneWhen.slice(0, 120)}`);
  console.log(`   proposed commands: ${JSON.stringify(plan.plan.commands)}; checks: ${JSON.stringify(plan.plan.checks)}`);
  verdict('the queue has 1 to 20 tasks, each depending only on earlier ones', plan.plan.tasks.length >= 1 && plan.plan.tasks.length <= 20 && plan.plan.tasks.every((task, i) => task.dependsOn.every((n) => n < i + 1)), `${plan.plan.tasks.length}`);

  // 2. Start: exactly one approved command, the same as the check; at most three tasks.
  const limit = Math.min(3, plan.plan.tasks.length);
  const startBody = { tasks: plan.plan.tasks, limit, commands: [COMMAND], checks: [COMMAND], fixRounds: 1, thresholds: { fiveHour: 90, week: 95 }, confirm: true };
  const startedBuild = await web.call('POST', `/api/builds/${id}/start`, startBody);
  verdict('the build started with the approved command and check', startedBuild.status === 200, `${startedBuild.status} ${startedBuild.body.slice(0, 300)}`);

  // 3. The unattended run.
  const done = await waitBuild(web, id, TERMINAL, 45 * 60_000);
  for (const task of done.tasks) {
    const checks = (task.task?.checks ?? []).map((c) => `${c.command}: ${c.timedOut ? 'timed out' : `exit ${c.exitCode}`}`).join('; ');
    console.log(`   task ${task.n} ${task.title}: ${task.state}${task.reason === undefined ? '' : ` (${task.reason}${task.detail === undefined ? '' : `: ${task.detail.slice(0, 200)}`})`}, ${task.rounds} round(s), checks [${checks}], denied ${JSON.stringify(task.denied ?? [])}`);
  }
  if (done.state === 'paused') console.log(`   paused: ${JSON.stringify(done.pause)}`);
  verdict('the build ran to its end on its own (finished, not paused or interrupted)', done.state === 'finished', `${done.state}${done.pause === undefined ? '' : ` ${JSON.stringify(done.pause)}`}`);
  const applied = done.tasks.filter((task) => task.state === 'applied');
  verdict('at least one task was applied to the integration branch', applied.length >= 1, `${applied.length} of ${done.tasks.length}; ${done.roundsRun} round(s) in all`);
  const head = await g(['rev-parse', `refs/heads/${done.branch}`]).catch(() => '');
  verdict("the integration branch's head is the last applied task's commit", head !== '' && head === [...applied].reverse()[0]?.commit, `${head.slice(0, 10)}`);
  verdict('nothing reached main before the apply: same HEAD, clean folder', (await g(['rev-parse', 'HEAD'])) === project.base && (await g(['status', '--porcelain'])) === '', '');
  const deniedAll = done.tasks.flatMap((task) => task.denied ?? []);
  console.log(`   commands denied in the build: ${deniedAll.length === 0 ? 'none' : deniedAll.map((entry) => `${entry.tool}: ${entry.text}`).join(' | ')}`);
  // What the real task sessions did, read from their own messages (the tap): every shell call against the approved list.
  const shellCalls = tap.calls.filter((call) => SHELL_TOOLS.includes(call.name));
  for (const call of shellCalls) {
    const command = typeof call.input.command === 'string' ? call.input.command : JSON.stringify(call.input);
    const result = tap.results.get(call.id);
    console.log(`   ${call.name} ${JSON.stringify(command.slice(0, 200))}: ${isApprovedCommand(command, [COMMAND]) ? 'on the list' : 'NOT on the list'}, ${result === undefined ? 'no result seen' : result.error ? `refused or failed: ${result.text.slice(0, 160)}` : 'ran'}`);
  }
  const offList = shellCalls.filter((call) => !isApprovedCommand(typeof call.input.command === 'string' ? call.input.command : '', [COMMAND]));
  verdict(
    'every shell command outside the approved list came back refused (none ran)',
    offList.every((call) => tap.results.get(call.id)?.error === true),
    `${shellCalls.length} shell call(s), ${offList.length} off the list, ${deniedAll.length} recorded as denied`,
  );
  verdict(
    'the task sessions were seen, and none offered Codex (builds never do)',
    tap.inits.length >= 1 && tap.inits.every((init) => !init.tools.includes(CODEX_TOOL_ID)),
    `${tap.inits.length} task session(s); Claude Code ${tap.inits[0]?.claudeCodeVersion ?? '?'}`,
  );
  notControlled('every denial happened without a dialog', 'a build round has no dialog to open; the unit tests show it, and this run prints each shell call and its result above');

  // 4. The plan readings before each task.
  for (const { at, reading } of readings) console.log(`   reading at ${at}: ${JSON.stringify(reading)}`);
  verdict('the plan was read before each task (one reading at least)', readings.length >= 1, `${readings.length} reading(s)`);
  const okReadings = readings.filter((entry) => entry.reading.kind === 'ok');
  const withReset = okReadings.filter((entry) => entry.reading.kind === 'ok' && (entry.reading.fiveHourResetsAt !== undefined || entry.reading.sevenDayResetsAt !== undefined));
  if (okReadings.length === 0) notControlled('resets_at for this login', `no reading with plan limits (${readings.map((entry) => entry.reading.kind).join(', ') || 'none'})`);
  else notControlled('resets_at for this login (informative, H0 point 2)', `${withReset.length} of ${okReadings.length} reading(s) carried a reset time`);

  // 5. The final apply: tasks still waiting are discarded first (the build refuses to drop them). Only a finished build:
  // a paused one keeps its resume timer, and the run already failed above.
  if (done.state === 'finished' && applied.length >= 1) {
    for (const task of done.tasks) {
      if (task.taskId === undefined || task.state === 'applied') continue;
      if (task.task !== undefined && ['proposal', 'failed', 'cancelled', 'interrupted'].includes(task.task.state)) {
        const discarded = await web.call('POST', `/api/tasks/${task.taskId}/discard`, { confirm: true });
        console.log(`   discarded waiting task ${task.n} before the apply: ${discarded.status}`);
      }
    }
    // As the page does: read the whole change, then apply naming the integration head it showed (docs/api.md).
    const diff = await web.call('GET', `/api/builds/${id}/diff`);
    const shown = diff.json() as { diff: { files: { path: string }[] } | null; head?: string };
    const files = (shown.diff?.files ?? []).map((file) => file.path);
    console.log(`   the whole change: ${files.join(', ') || 'empty'} (head ${shown.head?.slice(0, 10) ?? 'none'})`);
    const apply = await web.call('POST', `/api/builds/${id}/apply`, { confirm: true, head: shown.head });
    verdict('the build was applied', apply.status === 200 && (apply.json() as BuildSeen).state === 'applied', `${apply.status} ${apply.body.slice(0, 300)}`);
    verdict('one commit on main, on top of the base', (await g(['rev-parse', 'HEAD^'])) === project.base && (await g(['rev-parse', '--abbrev-ref', 'HEAD'])) === 'main', await g(['log', '-1', '--format=%s']));
    verdict('the project folder is clean', (await g(['status', '--porcelain'])) === '', '');
    verdict('src/greet.js is in the project', await exists(path.join(project.dir, 'src', 'greet.js')), (await readFile(path.join(project.dir, 'src', 'greet.js'), 'utf8').catch(() => '(missing)')).slice(0, 300));
    verdict('no remote: nothing could be pushed', (await g(['remote'])) === '', (await g(['remote'])) || 'none');
  } else {
    notControlled('the final apply', done.state === 'finished' ? 'no task was applied' : `the build is ${done.state}, not finished`);
  }

  await web.stop();
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

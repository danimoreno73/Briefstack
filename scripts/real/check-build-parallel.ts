// Real check (phase 11): the build's board with cards run in parallel. Through
// the real `briefstack web`, the real planner and real task sessions on the
// saver profile, in a temp home with a small sample project (tasks-common.ts),
// a fixed board of four cards started with two slots:
//   1. cards 1 and 2 have separate areas and no dependency, so they start at
//      the same time: seen in the build's log line (`1:running 2:running`)
//      and judged from the polls (both running, each with its own task);
//   2. a deterministic conflict: cards 1 and 2 both create `shared/NOTES.md`
//      (one line each, "one" and "two") from the same start, so whichever is
//      joined second collides when joined (add/add in `merge-tree`), whatever
//      the model writes in it; that card is redone once at the integration
//      head, where the file already holds the other card's line, and told to
//      keep it and add its own; then it is joined. PASS if exactly one of
//      the two has `redo.reason` `conflict`, both are applied, and the file
//      on the build's branch holds both lines. If the redone card's session
//      drops the other line, the join still goes through (nothing else
//      touches the file): that is the model, said apart;
//   3. cards 3 and 4 (4 depends on 3) run when a slot frees, as phase 9's;
//   4. the final apply as the page does it: the whole change read, then one
//      commit on `main`; nothing pushed (no remote);
//   5. the planner session tapped (its init's tools printed), every wait and
//      the server's stop with a deadline, and the processes of the sandbox
//      counted once the server stopped.
// The approved list is `node --test`; the build's check is
// `node scripts/check.js` (fails only on conflict markers); one fix round.
//
// Spends: one planner session and five short task sessions (saver profile:
// cards 1 to 4, and the one redo), plus any fix round the model makes needed,
// plus free plan readings. Two sessions run at the same time, so the 5-hour
// window is spent faster than by the phase 9 checks.
// Run:  npx tsx scripts/real/check-build-parallel.ts --yes

import { SdkBuildPlanner } from '../../src/builds/planner.js';
import { buildUsageReader, type UsageReading } from '../../src/builds/usage.js';
import { systemPathEnv } from '../../src/config/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { git, newTap, plannerReading, processesLeft, processesVerdict, sampleProject, startWeb, tappedQuery, usageGate, waitBuild, type BuildSeen } from './tasks-common.js';

requireConfirmation(
  'Phase 11 real check: a build in a temp home with a fixed board of four cards and two slots: two cards at the same time, a deterministic conflict redone and joined, and the final apply. It spends one planner session and five short task sessions (saver profile), two of them at once, plus free plan readings.',
);

const BRIEF = [
  '# notes: brief',
  '',
  '## Goal',
  '',
  'A folder of short notes, used to check how a build runs cards in parallel.',
  '',
  '## Deliverables',
  '',
  '1. `shared/NOTES.md` with the lines `one` and `two`, `notes/three.txt` and `notes/four.txt`, each holding one word.',
  '',
  '## Constraints',
  '',
  '- No dependencies. The only command available is `node --test`.',
  '',
].join('\n');

/** The build's check (a file of the sample project, CommonJS): it fails only when a file holds a conflict marker. */
const CHECK_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const bad = [];',
  'const walk = (dir) => {',
  '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {',
  "    if (entry.name === '.git' || entry.name === 'node_modules') continue;",
  '    const file = path.join(dir, entry.name);',
  '    if (entry.isDirectory()) walk(file);',
  "    else if (/^(<{7}|>{7}|={7})( |$)/m.test(fs.readFileSync(file, 'utf8'))) bad.push(file);",
  '  }',
  '};',
  "walk('.');",
  "if (bad.length > 0) { console.log('CHECK FAILS: conflict markers in ' + bad.join(', ')); process.exit(1); }",
  "console.log('CHECK PASSES.');",
  '',
].join('\n');

const COMMAND = 'node --test';
const CHECK = 'node scripts/check.js';
const SLOTS = 2;
const TERMINAL = ['finished', 'paused', 'interrupted', 'cancelled'];
const SHARED = 'shared/NOTES.md';

const shared = (word: string): string =>
  [
    `Make sure the file ${SHARED} exists and holds the line ${word}.`,
    `If ${SHARED} does not exist, create it holding exactly one line: ${word}`,
    `If it already exists, keep every line it has, exactly as it is, and add the line ${word} at the end.`,
    'Change nothing else. Do not run any command, not even to check your work: briefstack runs the check itself.',
  ].join('\n');

/** The fixed board the script starts the build with, in place of the planner's. Cards 1 and 2 share no area on purpose. */
const BOARD = [
  { title: 'Add the line one', instruction: shared('one'), doneWhen: `${SHARED} holds the line one.`, dependsOn: [], area: ['notes/one/'], size: 'S' },
  { title: 'Add the line two', instruction: shared('two'), doneWhen: `${SHARED} holds the line two.`, dependsOn: [], area: ['notes/two/'], size: 'S' },
  {
    title: 'Write the third note',
    instruction: 'Write the file notes/three.txt holding the word three. Change nothing else. Do not run any command.',
    doneWhen: 'notes/three.txt holds the word three.',
    dependsOn: [],
    area: ['notes/three.txt'],
    size: 'S',
  },
  {
    title: 'Write the fourth note',
    instruction: 'Write the file notes/four.txt holding the word four. Change nothing else. Do not run any command.',
    doneWhen: 'notes/four.txt holds the word four.',
    dependsOn: [3],
    area: ['notes/four.txt'],
    size: 'S',
  },
];

type CardSeen = BuildSeen['tasks'][number] & { redo?: { reason: string; previousTask: string }; join?: { outcome: string; merged: boolean; files?: string[] } };

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

try {
  const executable = claudeExecutable();
  const box = await sandbox('build-parallel');
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
  });
  const g = (args: string[]) => git(project.dir, args, project.emptyHooks).then((out) => out.trim());

  // 1. Plan: the real planner session runs and must answer (with areas and sizes); its board is then replaced.
  const planned = await web.call('POST', `/api/projects/${project.slug}/builds`, { force: true });
  verdict('the build was created and the planner started', planned.status === 201, `${planned.status} ${planned.body.slice(0, 200)}`);
  const id = (planned.json() as { id: string }).id;
  const plan = await waitBuild(web, id, ['planned', 'planFailed'], 10 * 60_000);
  verdict('the planner answered with a board', plan.state === 'planned', plan.state === 'planned' ? `${plan.plan?.tasks.length ?? 0} card(s), replaced by the fixed board of ${BOARD.length}` : (plan.error ?? 'no error recorded'));
  const proposed = (plan.plan?.tasks ?? []) as { area?: string[]; size?: string }[];
  if (plan.state === 'planned') {
    const complete = proposed.filter((card) => Array.isArray(card.area) && card.area.length > 0 && typeof card.size === 'string').length;
    verdict("the planner gave every card an area and a size (the planner's JSON schema)", complete === proposed.length && proposed.length > 0, `${complete} of ${proposed.length}: ${JSON.stringify(proposed.map((card) => [card.area, card.size])).slice(0, 300)}`);
  }
  const planner = plannerReading(plannerTap);
  verdict('the planner session had no tool but StructuredOutput, and called no other', planner.ok, planner.detail);
  if (plan.state !== 'planned') throw new Error('The planner gave no board: the build cannot start.');

  // 2. Start with the fixed board, two slots, the one approved command, the check and one fix round.
  const startBody = { tasks: BOARD, limit: BOARD.length, commands: [COMMAND], checks: [CHECK], fixRounds: 1, thresholds: { fiveHour: 90, week: 95 }, slots: SLOTS, confirm: true };
  const startedBuild = await web.call('POST', `/api/builds/${id}/start`, startBody);
  verdict('the build started with the fixed board and two slots', startedBuild.status === 200 && (startedBuild.json() as { settings?: { slots?: number } }).settings?.slots === SLOTS, `${startedBuild.status} ${startedBuild.body.slice(0, 300)}`);

  // 3. The unattended run. Every poll notes which cards run with a task of their own.
  let together: { at: string; cards: string[] } | undefined;
  const done = await waitBuild(web, id, TERMINAL, 60 * 60_000, async (build: BuildSeen) => {
    const running = build.tasks.filter((task) => task.state === 'running' && task.taskId !== undefined);
    if (running.length >= 2 && together === undefined) {
      together = { at: new Date().toISOString(), cards: running.map((task) => `${task.n}:${task.taskId}`) };
      console.log(`   seen at once: ${together.cards.join(', ')} (${together.at})`);
    }
  });
  const cards = done.tasks as CardSeen[];
  for (const task of cards) {
    const checks = (task.task?.checks ?? []).map((c) => `${c.command}: ${c.timedOut ? 'timed out' : `exit ${c.exitCode}`}`).join('; ');
    const tokens = task.task?.claudeTokens === undefined ? 'no reading' : `${task.task.claudeTokens.noCache} (${task.task.claudeTokens.withCache} with cache)`;
    console.log(
      `   card ${task.n} ${task.title}: ${task.state}${task.reason === undefined ? '' : ` (${task.reason})`}, ${task.rounds} round(s), redo ${JSON.stringify(task.redo ?? null)}, join ${JSON.stringify(task.join ?? null)}, checks [${checks}], Claude tokens ${tokens}, denied ${JSON.stringify(task.denied ?? [])}`,
    );
  }
  if (done.state === 'paused') console.log(`   paused: ${JSON.stringify(done.pause)}`);
  verdict('the build ran to its end on its own (finished)', done.state === 'finished', `${done.state}${done.pause === undefined ? '' : ` ${JSON.stringify(done.pause)}`}`);
  const [c1, c2, c3, c4] = cards;

  // ---- 1. Two cards at the same time ----
  verdict('1. two independent cards ran at the same time, each with its own task', together !== undefined && new Set(together.cards.map((card) => card.split(':')[1])).size >= 2, together === undefined ? 'never two cards running at once in the polls' : together.cards.join(', '));

  // ---- 2. The deterministic conflict, redone and joined ----
  const redone = [c1, c2].filter((card) => card?.redo?.reason === 'conflict');
  verdict('2. exactly one of cards 1 and 2 collided when joined and was redone once', redone.length === 1, JSON.stringify([c1?.redo ?? null, c2?.redo ?? null]));
  verdict('2. cards 1 and 2 were both applied to the build\'s branch', c1?.state === 'applied' && c2?.state === 'applied' && c1.commit !== undefined && c2.commit !== undefined, `${c1?.state ?? 'missing'}${c1?.reason === undefined ? '' : ` (${c1.reason})`}, ${c2?.state ?? 'missing'}${c2?.reason === undefined ? '' : ` (${c2.reason})`}`);
  const onBranch = await g(['show', `refs/heads/${done.branch}:${SHARED}`]).catch(() => undefined);
  const lines = (onBranch ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  console.log(`   ${SHARED} on the build's branch: ${JSON.stringify(onBranch ?? null)}`);
  if (redone.length === 1 && onBranch !== undefined && !(lines.includes('one') && lines.includes('two'))) {
    notControlled(`2. ${SHARED} holds both lines`, `the redone card's session did not keep the other line (the model, not the build): ${JSON.stringify(lines)}`);
  } else verdict(`2. ${SHARED} holds both lines, and no conflict marker`, lines.includes('one') && lines.includes('two') && !/^(<{7}|>{7}|={7})/m.test(onBranch ?? ''), JSON.stringify(lines));

  // ---- 3. The other cards ----
  verdict('3. cards 3 and 4 were applied (4 after 3, its dependency)', c3?.state === 'applied' && c4?.state === 'applied', `${c3?.state ?? 'missing'}, ${c4?.state ?? 'missing'}`);
  verdict('nothing reached main before the apply: same HEAD, clean folder', (await g(['rev-parse', 'HEAD'])) === project.base && (await g(['status', '--porcelain'])) === '', '');
  for (const { at, reading } of readings) console.log(`   reading at ${at}: ${JSON.stringify(reading)}`);
  verdict('the plan was read before cards started (one reading at least)', readings.length >= 1, `${readings.length} reading(s)`);

  // ---- 4. The final apply, as the page does it ----
  if (done.state === 'finished' && cards.some((card) => card.state === 'applied')) {
    for (const task of cards) {
      if (task.taskId === undefined || task.state === 'applied') continue;
      if (task.task !== undefined && ['proposal', 'failed', 'cancelled', 'interrupted'].includes(task.task.state)) {
        const discarded = await web.call('POST', `/api/tasks/${task.taskId}/discard`, { confirm: true });
        console.log(`   discarded waiting card ${task.n} before the apply: ${discarded.status}`);
      }
    }
    const diff = await web.call('GET', `/api/builds/${id}/diff`);
    const shown = diff.json() as { diff: { files: { path: string }[] } | null; head?: string };
    console.log(`   the whole change: ${(shown.diff?.files ?? []).map((file) => file.path).join(', ') || 'empty'} (head ${shown.head?.slice(0, 10) ?? 'none'})`);
    const apply = await web.call('POST', `/api/builds/${id}/apply`, { confirm: true, head: shown.head });
    verdict('4. the build was applied', apply.status === 200 && (apply.json() as BuildSeen).state === 'applied', `${apply.status} ${apply.body.slice(0, 300)}`);
    verdict('4. one commit on main, on top of the base', (await g(['rev-parse', 'HEAD^'])) === project.base && (await g(['rev-parse', '--abbrev-ref', 'HEAD'])) === 'main', await g(['log', '-1', '--format=%s']));
    verdict('4. the project folder is clean', (await g(['status', '--porcelain'])) === '', '');
    verdict(`4. ${SHARED} is in the project with both lines`, /\bone\b/.test(await g(['show', `HEAD:${SHARED}`]).catch(() => '')) && /\btwo\b/.test(await g(['show', `HEAD:${SHARED}`]).catch(() => '')), await g(['show', `HEAD:${SHARED}`]).catch(() => '(missing)'));
    verdict('4. no remote: nothing could be pushed', (await g(['remote'])) === '', (await g(['remote'])) || 'none');
  } else {
    notControlled('the final apply', done.state === 'finished' ? 'no card was applied' : `the build is ${done.state}, not finished`);
  }

  // ---- 5. The stop: with a deadline, then no process of the sandbox left ----
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

// Real check (phase 12): a short build whose cards go on with a reserve
// provider at a forced usage threshold. Run it inside the container, on
// Linux, after the provider is in your config.json and its key file exists:
//
//   npx tsx scripts/real/check-build-reserve.ts --yes --provider <name>
//
// It reads the provider (name, base URL, models, key file path) from your
// real config.json, then works in a temp home (`sandbox()`, common.ts) with
// the real `briefstack web` in this process, the real task runner and a
// small sample project. The planner is a fixed board (no Claude session) and
// the plan usage reading is forced over the threshold (no Claude session):
// every card of the build starts on the provider. What it checks:
//   1. the provider's status check (no key sent): the key file is there and
//      the address answers;
//   2. the build starts with the reserve; both cards run on the provider
//      (each card's `provider`, each round's `provider`, the session's model
//      as Claude Code reports it, permission mode `default`), and are applied;
//   3. the round's environment: the provider's base URL, no Anthropic
//      credential of yours, the subprocess scrub on; a card runs an approved
//      command that writes whether ANTHROPIC_AUTH_TOKEN is set in its own
//      environment (yes or no, never the value);
//   4. tokens were counted for each card (the SDK's count);
//   5. the key is in no API answer, no line the server printed, and no file
//      of the temp home or the project;
//   6. nothing reached main before the apply; the processes of the sandbox
//      are gone once the server stopped.
//
// Spends: two short sessions on the provider (each card one round, no fix
// round), billed to its key. No Claude session: no planner, no usage reading.
// The key is read by this script only to look for it; it is never printed.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import type { UsageReading } from '../../src/builds/usage.js';
import { configFilePath, readConfig, reserveProvidersOf, systemPathEnv, updateConfig } from '../../src/config/index.js';
import type { QueryFn } from '../../src/creation/sdkRunner.js';
import { readProviderKey } from '../../src/providers/env.js';
import { report, requireConfirmation, sandbox, startCheck } from './common.js';
import { git, newTap, processesLeft, processesVerdict, sampleProject, startWeb, tappedQuery, waitBuild, type BuildSeen } from './tasks-common.js';

requireConfirmation(
  'Phase 12 real check: a short build in a temp home whose two cards go on with a reserve provider at a forced usage threshold.',
  'It spends two short sessions on that provider, billed to its key, and no Claude session (no planner, no usage reading).',
);

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const COMMAND = 'node scripts/env-check.js';
const TERMINAL = ['finished', 'paused', 'interrupted', 'cancelled'];
/** A sample project's script: writes whether the provider's token variable is set in its environment, never its value. */
const ENV_CHECK = [
  "const fs = require('node:fs');",
  "const set = typeof process.env.ANTHROPIC_AUTH_TOKEN === 'string' && process.env.ANTHROPIC_AUTH_TOKEN !== '';",
  "fs.writeFileSync('notes/env.txt', 'ANTHROPIC_AUTH_TOKEN set: ' + (set ? 'yes' : 'no') + '\\n');",
  "console.log('written notes/env.txt');",
  '',
].join('\n');
const BRIEF = ['# notes: brief', '', '## Goal', '', 'Two short notes, written by a reserve provider during a real check.', '', '## Constraints', '', `- The only command available is \`${COMMAND}\`.`, ''].join('\n');
const BOARD = [
  {
    title: 'Run the environment check',
    instruction: `Run the command ${COMMAND} exactly once, then stop. Change nothing else.`,
    doneWhen: 'notes/env.txt exists.',
    dependsOn: [],
    area: ['notes/env.txt'],
    size: 'S',
  },
  {
    title: 'Write the second note',
    instruction: 'Write the file notes/two.txt holding the word two. Change nothing else. Do not run any command.',
    doneWhen: 'notes/two.txt holds the word two.',
    dependsOn: [],
    area: ['notes/two.txt'],
    size: 'S',
  },
];
/** Over the 5-hour threshold, with a reset an hour ahead: the build goes on with the reserve (a pause would wait for it). */
const forced = (): UsageReading => ({ kind: 'ok', fiveHour: 99, sevenDay: 10, fiveHourResetsAt: new Date(Date.now() + 60 * 60_000).toISOString() });

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

/** Every file under `dir` that holds `needle` (relative paths); unreadable files skipped. */
async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if ((await readFile(file, 'utf8').catch(() => '')).includes(needle)) found.push(path.relative(dir, file));
    }
  };
  await walk(dir);
  return found;
}

try {
  const name = option('--provider');
  if (name === undefined) throw new Error('Give --provider <name>, one of reserveProviders in your config.json.');
  // Read before the sandbox moves BRIEFSTACK_HOME: the user's own config, read only.
  const provider = reserveProvidersOf(await readConfig(configFilePath(systemPathEnv()))).find((entry) => entry.name === name);
  if (provider === undefined) throw new Error(`No reserve provider "${name}" in your config.json.`);
  const key = await readProviderKey(provider);
  const smallModel = provider.smallModel === undefined ? '' : `, small model ${provider.smallModel}`;
  console.log(`Provider ${provider.name}: ${provider.baseUrl}, model ${provider.model}${smallModel}, its file ${provider.keyFile}: read, and its content never printed.`);

  const box = await sandbox('build-reserve');
  check.add(() => box.cleanup());
  const tap = newTap();
  // Handed to the task runner, so its sessions are closed with the server, as `startWeb`'s own tapped query.
  const tapped = tappedQuery(tap);
  // What each round's options held, without values: the round's model, mode and the names of its environment.
  const shapes: { model: string | undefined; mode: string | undefined; baseUrl: string | undefined; scrub: string | undefined; userCredentials: string[] }[] = [];
  const query: QueryFn = (params) => {
    const options = params.options as Options;
    const env = options.env ?? {};
    shapes.push({
      model: options.model,
      mode: options.permissionMode,
      baseUrl: env.ANTHROPIC_BASE_URL,
      scrub: env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
      userCredentials: Object.keys(env).filter((variable) => variable === 'ANTHROPIC_API_KEY' || variable.startsWith('CLAUDE_CODE_OAUTH_') || variable.startsWith('CLAUDE_CODE_USE_') || (variable === 'ANTHROPIC_AUTH_TOKEN' && env[variable] !== key)),
    });
    return tapped(params);
  };
  const web = await startWeb(check, box, tap, { buildPlanner: new FakeBuildPlanner({ tasks: BOARD as never, commands: [COMMAND], checks: [] }), buildUsage: async () => forced() }, query);
  await updateConfig(path.join(box.home, 'config.json'), { reserveProviders: [provider] });
  const project = await sampleProject(box, 'notes', { 'docs/BRIEF.md': BRIEF, 'scripts/env-check.js': ENV_CHECK, 'notes/.keep': '' });
  const g = (args: string[]) => git(project.dir, args, project.emptyHooks).then((out) => out.trim());

  // 1. The status check.
  const checked = await web.call('POST', `/api/providers/${encodeURIComponent(provider.name)}/check`);
  const result = checked.json() as { keyFile?: string; endpoint?: string; status?: number; key?: string };
  verdict('1. the status check finds the key file and the address answers, the key not checked', checked.status === 200 && result.keyFile === 'present' && result.endpoint === 'reachable' && result.key === 'notChecked', checked.body.slice(0, 200));

  // 2. Plan (fixed board) and start with the reserve.
  const planned = await web.call('POST', `/api/projects/${project.slug}/builds`, { force: true });
  const id = (planned.json() as { id: string }).id;
  const plan = await waitBuild(web, id, ['planned', 'planFailed'], 2 * 60_000);
  if (plan.state !== 'planned') throw new Error(`The fixed board was not taken: ${plan.state}`);
  const start = await web.call('POST', `/api/builds/${id}/start`, { tasks: BOARD, limit: BOARD.length, commands: [COMMAND], checks: [], noChecks: true, fixRounds: 0, thresholds: { fiveHour: 80, week: 95 }, slots: 1, reserve: provider.name, confirm: true });
  verdict('2. the build started with the reserve', start.status === 200 && (start.json() as { settings?: { reserve?: string } }).settings?.reserve === provider.name, `${start.status} ${start.body.slice(0, 200)}`);
  const done = await waitBuild(web, id, TERMINAL, 30 * 60_000);
  const cards = done.tasks as (BuildSeen['tasks'][number] & { provider?: string })[];
  for (const card of cards) console.log(`   card ${card.n} ${card.title}: ${card.state}${card.reason === undefined ? '' : ` (${card.reason})`}, provider ${card.provider ?? 'Claude'}, tokens ${JSON.stringify(card.task?.claudeTokens ?? null)}, denied ${JSON.stringify(card.denied ?? [])}`);
  verdict('2. the build ran to its end on its own (finished)', done.state === 'finished', `${done.state}${done.pause === undefined ? '' : ` ${JSON.stringify(done.pause)}`}`);
  verdict('2. both cards ran on the provider', cards.length === 2 && cards.every((card) => card.provider === provider.name), cards.map((card) => card.provider ?? 'Claude').join(', '));
  verdict('2. both cards were applied to the build\'s branch', cards.every((card) => card.state === 'applied'), cards.map((card) => card.state).join(', '));
  const rounds: string[] = [];
  for (const card of cards) {
    if (card.taskId === undefined) continue;
    const task = (await web.call('GET', `/api/tasks/${card.taskId}`)).json() as { rounds?: { provider?: string }[] };
    for (const round of task.rounds ?? []) rounds.push(round.provider ?? 'Claude');
  }
  verdict('2. every round records the provider', rounds.length >= 2 && rounds.every((entry) => entry === provider.name), rounds.join(', '));
  verdict('2. no Claude session: every session the runner started was the provider\'s', shapes.length >= 2 && shapes.every((shape) => shape.baseUrl === provider.baseUrl), `${shapes.length} session(s)`);
  verdict('2. each round asked for the provider\'s model, in permission mode default', shapes.every((shape) => shape.model === provider.model && shape.mode === 'default'), JSON.stringify(shapes.map((shape) => [shape.model, shape.mode])));
  const inits = tap.inits.map((init) => `${init.model} (${init.permissionMode})`);
  console.log(`   sessions as Claude Code reported them: ${inits.join(', ') || 'none'}`);
  if (tap.inits.length === 0) notControlled('2. the model Claude Code reported', 'no init message was seen');

  // 3. The round's environment.
  verdict('3. no Anthropic credential of yours in a provider round, and the subprocess scrub on', shapes.every((shape) => shape.userCredentials.length === 0 && shape.scrub === '1'), JSON.stringify(shapes.map((shape) => [shape.userCredentials, shape.scrub])));
  const envNote = await g(['show', `refs/heads/${done.branch}:notes/env.txt`]).catch(() => undefined);
  console.log(`   notes/env.txt on the build's branch: ${JSON.stringify(envNote ?? null)}`);
  if (envNote === undefined) notControlled('3. the token is not in an approved command\'s environment', 'the card did not run the command (the model), so nothing was written');
  else verdict('3. the token is not in an approved command\'s environment (Claude Code\'s scrub)', envNote.trim() === 'ANTHROPIC_AUTH_TOKEN set: no', envNote.trim());

  // 4. Tokens.
  verdict('4. tokens were counted for each card', cards.every((card) => (card.task?.claudeTokens?.noCache ?? 0) > 0), cards.map((card) => card.task?.claudeTokens?.noCache ?? 0).join(', '));

  // 5. The key nowhere.
  const answers = [checked.body, start.body, JSON.stringify(done), (await web.call('GET', '/api/providers')).body, (await web.call('GET', `/api/builds/${id}`)).body].join('\n');
  verdict('5. the key is in no API answer', !answers.includes(key), '');
  verdict('5. the key is in no line the server printed', !web.log.join('\n').includes(key), `${web.log.length} line(s)`);
  const inHome = await filesHolding(box.home, key);
  const inProject = await filesHolding(project.dir, key);
  verdict('5. the key is in no file of the temp home or the project (sessions, tasks, builds; git objects are compressed and not looked into)', inHome.length === 0 && inProject.length === 0, [...inHome, ...inProject].join(', ') || 'none');

  // 6. Main untouched; processes.
  verdict('6. nothing reached main: same HEAD, clean folder', (await g(['rev-parse', 'HEAD'])) === project.base && (await g(['status', '--porcelain'])) === '', '');
  await web.stop();
  const left = processesVerdict(await processesLeft(box));
  if (left.verdict === 'NOT CONTROLLED') notControlled('6. no process of the sandbox is left once the server stopped', left.detail);
  else verdict('6. no process of the sandbox is left once the server stopped', left.verdict === 'PASS', left.detail);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
console.log('\nSummary');
for (const row of table) console.log(`${row.verdict.padEnd(14)} ${row.name}${row.detail === '' ? '' : `: ${row.detail}`}`);
process.exit(check.exitCode(ok));

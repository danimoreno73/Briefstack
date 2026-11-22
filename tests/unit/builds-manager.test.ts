import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrationHead } from '../../src/builds/git.js';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import { capDenied, MAX_DENIED_KEPT, type PlanOutput } from '../../src/builds/types.js';
import type { UsageReading } from '../../src/builds/usage.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { FAKE_USAGE, TaskFakeRunner, type TaskFakeScript, type TaskFakeStep } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import type { CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// Builds (BRIEF-phase-9 §3; PLAN-phase-9 M3 and M4) over the fake planner and
// the fake task runner, on a temp git repository.

useHermeticGit();

let world: TaskWorld;
let project: string;

const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- A list.\n- A total.\n- A report.\n';

const PLAN: PlanOutput = {
  tasks: [
    { title: 'List', instruction: 'Write LIST.md.', doneWhen: 'LIST.md exists.', dependsOn: [] },
    { title: 'Total', instruction: 'Write TOTAL.md.', doneWhen: 'TOTAL.md exists.', dependsOn: [] },
    { title: 'Report', instruction: 'Write REPORT.md from the total.', doneWhen: 'REPORT.md exists.', dependsOn: [2] },
  ],
  commands: ['npm test', 'npm run lint'],
  checks: ['npm test'],
};

/** Checks that fail while the worktree has a `BROKEN` file. */
function fileChecks(): { checks: TaskChecks; runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    checks: {
      commands: async () => [],
      run: async (worktree, commands): Promise<CheckResult[]> => {
        const broken = await access(path.join(worktree, 'BROKEN')).then(
          () => true,
          () => false,
        );
        runs.push(path.basename(path.dirname(worktree)));
        return commands.map((command) => ({ command, exitCode: broken ? 1 : 0, timedOut: false, output: broken ? 'FAIL: BROKEN is there' : 'ok', durationMs: 1 }));
      },
    },
  };
}

/** Each task writes its file; "Total" also leaves BROKEN, in every round, so its checks keep failing. */
const script: TaskFakeScript = (_round, prompt) => {
  const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'X';
  const steps: TaskFakeStep[] = [{ kind: 'write', file: `${title.toUpperCase()}.md`, content: `${title}.\n` }];
  if (title === 'Total') steps.push({ kind: 'write', file: 'BROKEN', content: 'x\n' });
  steps.push({ kind: 'end', summary: `Wrote ${title}.` });
  return { steps };
};

interface Setup {
  builds: BuildManager;
  tasks: TaskManager;
  runner: TaskFakeRunner;
  planner: FakeBuildPlanner;
  runs: string[];
  /** The readings not made yet. */
  readings: Reading[];
  /** When each reading was made (ms). */
  readAt: number[];
}

/** A reading, or how to make it at the moment it is read (a reset time relative to then), or a promise the test settles. */
type Reading = UsageReading | (() => UsageReading | Promise<UsageReading>);

interface SetupOptions {
  plan?: PlanOutput | Error;
  usage?: Reading[];
  roundsCap?: number;
  script?: TaskFakeScript;
  /** Other sessions holding places in the shared limit as the task manager sees it (creations), changed by the test. */
  others?: string[];
  /** A creation on the project's folder as the task manager sees it, changed by the test. */
  folder?: { holder?: string };
  maxActive?: number;
  checks?: TaskChecks;
  usageRetryMs?: number;
}

function setup(options: SetupOptions = {}): Setup {
  const holder: { builds?: BuildManager } = {};
  const runner = new TaskFakeRunner({ script: options.script ?? script });
  const files = fileChecks();
  const checks = options.checks ?? files.checks;
  const runs = files.runs;
  const others = options.others;
  const maxActive = options.maxActive ?? 2;
  const tasks = new TaskManager({
    runner,
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => maxActive,
    pollMs: 10,
    afterRound: afterRoundWith(),
    checks,
    buildOn: (slug) => holder.builds?.holder(slug),
    buildDrives: (id) => holder.builds?.drives(id) ?? false,
    ...(others === undefined && options.folder === undefined ? {} : { creations: { activeIds: () => others ?? [], folderHolder: () => options.folder?.holder } }),
  });
  const planner = new FakeBuildPlanner(options.plan ?? PLAN);
  const readings = [...(options.usage ?? [])];
  const readAt: number[] = [];
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => maxActive,
    ...(options.usage === undefined
      ? {}
      : {
          usage: async (): Promise<UsageReading> => {
            readAt.push(Date.now());
            const next = readings.shift() ?? { kind: 'unavailable' };
            return typeof next === 'function' ? next() : next;
          },
        }),
    ...(options.roundsCap === undefined ? {} : { roundsCap: options.roundsCap }),
    usageRetryMs: options.usageRetryMs ?? 60_000,
    slotRetryMs: 20,
  });
  holder.builds = builds;
  return { builds, tasks, runner, planner, runs, readings, readAt };
}

const start = (plan: PlanOutput = PLAN, overrides: Partial<BuildStartInput> = {}): BuildStartInput => ({
  tasks: plan.tasks,
  limit: plan.tasks.length,
  commands: plan.commands,
  checks: plan.checks,
  fixRounds: 1,
  thresholds: { fiveHour: 80, week: 90 },
  // A start with no checks says so (step 33); harmless with checks.
  noChecks: true,
  ...overrides,
});

async function planned(s: Setup): Promise<string> {
  const build = await s.builds.plan('garden');
  await s.builds.idle(build.id);
  expect((await s.builds.get(build.id)).state).toBe('planned');
  return build.id;
}

beforeEach(async () => {
  world = await taskWorld('builds-manager');
  project = await world.project('garden', { 'docs/BRIEF.md': BRIEF, 'package.json': JSON.stringify({ scripts: { test: 'node test.js', lint: 'eslint .' } }) });
});
afterEach(() => world.cleanup());

describe('planning a build', () => {
  it('reads the brief, CLAUDE.md and the scripts at the head, and keeps the planner\'s queue as a proposal', async () => {
    const s = setup();
    try {
      const build = await s.builds.plan('garden');
      expect(build.state).toBe('planning');
      expect(await s.builds.holder('garden')).toBe(build.id);
      await s.builds.idle(build.id);
      const view = await s.builds.get(build.id);
      expect(view.state).toBe('planned');
      expect(view.plan).toEqual(PLAN);
      expect(view.tasks).toEqual([]);
      const input = s.planner.runs[0]?.input;
      expect(input?.brief).toBe(BRIEF);
      expect(input?.claudeMd).toBe('# garden\n');
      expect(input?.scripts).toEqual({ test: 'node test.js', lint: 'eslint .' });
      expect(s.planner.runs[0]?.model).toBe('sonnet');
      // The build holds the project: no ordinary task, no second build.
      await expect(s.tasks.start('garden', 'Something.')).rejects.toMatchObject({ code: 'task.buildOnProject' });
      await expect(s.builds.plan('garden')).rejects.toMatchObject({ code: 'build.projectBusy' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('refuses a project without docs/BRIEF.md, and records a planner that failed', async () => {
    await world.project('orchard');
    const s = setup({ plan: new Error('The planner session ended with error_max_turns.') });
    try {
      await expect(s.builds.plan('orchard')).rejects.toMatchObject({ code: 'build.noBrief' });
      const build = await s.builds.plan('garden');
      await s.builds.idle(build.id);
      const view = await s.builds.get(build.id);
      expect(view.state).toBe('planFailed');
      expect(view.error).toContain('error_max_turns');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

describe('starting a build', () => {
  it('refuses a start that breaks the rules, with every issue', async () => {
    const s = setup();
    try {
      const id = await planned(s);
      const bad = start(PLAN, {
        tasks: [PLAN.tasks[0] as never, { ...PLAN.tasks[1], dependsOn: [2] } as never],
        limit: 3,
        commands: ['npm test', 'npm ci && npm test', 'rm -rf *'],
        checks: ['npm test', 'npm test'],
        fixRounds: 3,
        thresholds: { fiveHour: 0, week: 90 },
      });
      const error = (await s.builds.start(id, bad).catch((failure: unknown) => failure)) as { code: string; params: { issues: string[] } };
      expect(error.code).toBe('build.invalidStart');
      expect(error.params.issues).toEqual([
        'task 2: it may depend only on earlier tasks',
        "how many tasks to run: from 1 to the queue's length",
        'commands line 2: more than one command (list each part on its own)',
        'commands line 3: a wildcard',
        'checks: the same command twice',
        'fix rounds: 0 to 2',
        'usage threshold fiveHour: 1 to 100',
      ]);
      expect((await s.builds.get(id)).state).toBe('planned');
      expect(await integrationHead(project, `briefstack/build-${id}`)).toBeUndefined();
      // Each issue also as a code the page translates (step 33).
      expect((error.params as { items?: { key: string }[] }).items?.map((item) => item.key)).toEqual(['laterDependency', 'limit', 'listLine', 'listLine', 'listDuplicate', 'fixRounds', 'threshold']);
      // No checks and no confirmation of it: refused, with its own issue (review of M3, minor; step 33).
      const unchecked = (await s.builds.start(id, start(PLAN, { checks: [], noChecks: false })).catch((failure: unknown) => failure)) as { code: string; params: { items: { key: string }[] } };
      expect(unchecked).toMatchObject({ code: 'build.invalidStart', params: { items: [{ key: 'noChecks' }] } });
      expect((await s.builds.get(id)).state).toBe('planned');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('runs the queue: a task applied, a failing one fixed once then left waiting, its dependent skipped; the folder untouched', async () => {
    const s = setup();
    try {
      const before = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
      const id = await planned(s);
      const started = await s.builds.start(id, start());
      expect(started.state).toBe('running');
      expect(started.baseCommit).toBe(before);
      expect(started.baseBranch).toBe('main');
      expect(started.settings).toMatchObject({ limit: 3, fixRounds: 1, maxRounds: 6, commands: PLAN.commands, checks: ['npm test'] });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.n, task.state, task.reason ?? null, task.rounds])).toEqual([
        [1, 'applied', null, 1],
        [2, 'waiting', 'checksFailed', 2],
        [3, 'skipped', null, 0],
      ]);
      expect(done.tasks[2]?.skippedFor).toBe(2);
      expect(done.roundsRun).toBe(3);
      // Task 1 is the integration branch's one commit; the folder's branch did not move.
      const head = await integrationHead(project, done.branch);
      expect(head).toBe(done.tasks[0]?.commit);
      expect((await gitIn(project, 'show', `${head as string}:LIST.md`)).trim()).toBe('List.');
      expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(before);
      expect(await gitIn(project, 'status', '--porcelain')).toBe('');
      // Every round ran unattended; the fix round read what failed.
      expect(s.runner.started.every((round) => round.unattended === true)).toBe(true);
      expect(s.runner.started[2]?.prompt).toContain('This is fix round 2.');
      expect(s.runner.started[2]?.prompt).toContain('FAIL: BROKEN is there');
      // The waiting task is an ordinary task on its own page: open, its proposal kept.
      const waiting = await s.tasks.get(done.tasks[1]?.taskId as string);
      expect(waiting.state).toBe('proposal');
      expect(waiting.build).toEqual({ id, n: 2 });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a denied command leaves the task waiting even when its checks pass; how many tasks to run is kept', async () => {
    const denying: TaskFakeScript = (_round, prompt) => {
      const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'X';
      return { steps: [{ kind: 'shell', command: 'curl https://example.com' }, { kind: 'write', file: `${title}.md`, content: 'x\n' }, { kind: 'end', summary: 'Done.' }] };
    };
    const s = setup({ script: denying });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1, fixRounds: 0 }));
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
        ['waiting', 'denied'],
        ['queued', null],
        ['queued', null],
      ]);
      expect(done.tasks[0]?.denied).toEqual([{ tool: 'Bash', text: 'curl https://example.com' }]);
      expect(done.tasks[0]?.deniedOmitted).toBeUndefined();
      expect(done.state).toBe('finished');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a task\'s denied list is capped in build.json; the rest are counted (review of M3, minor; step 33)', async () => {
    const many = MAX_DENIED_KEPT + 7;
    const denying: TaskFakeScript = () => ({
      steps: [...Array.from({ length: many }, (_, i): TaskFakeStep => ({ kind: 'shell', command: `curl https://example.com/${i}` })), { kind: 'write', file: 'A.md', content: 'x\n' }, { kind: 'end', summary: 'Done.' }],
    });
    const s = setup({ script: denying });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1, fixRounds: 0 }));
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks[0]?.denied).toHaveLength(MAX_DENIED_KEPT);
      expect(done.tasks[0]?.denied?.[0]?.text).toBe('curl https://example.com/0');
      expect(done.tasks[0]?.deniedOmitted).toBe(7);
      expect(capDenied(done.tasks[0]?.denied ?? [], 7, [{ tool: 'Bash', text: 'x' }])).toMatchObject({ deniedOmitted: 8 });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

/** Polls until `check` holds, or fails after `ms` (under the 30 s test limit: a full parallel run on Windows is slow). */
async function until(check: () => boolean | Promise<boolean>, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A round that works for a long time (a minute) before it ends: only a stop or a cancel ends it sooner. */
const slow: TaskFakeScript = () => ({ steps: [{ kind: 'wait', ms: 60_000 }, { kind: 'write', file: 'SLOW.md', content: 'x\n' }, { kind: 'end', summary: 'Done.' }] });

describe('stopping, the shared limit and an unstarted build (review of M3)', () => {
  it('a server stop during a build\'s round ends the round at once and leaves the build for recover(): interrupted, its task waiting (B1)', async () => {
    const s = setup({ script: slow });
    const id = await planned(s);
    await s.builds.start(id, start(PLAN, { limit: 1 }));
    await until(() => s.tasks.activeIds().length === 1);
    const began = Date.now();
    // The server's order: the builds stop without waiting, the task manager ends the round, then the builds' loops are awaited.
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    expect(Date.now() - began).toBeLessThan(10_000);
    const after = setup();
    try {
      expect(await after.builds.recover()).toBe(1);
      const view = await after.builds.get(id);
      expect(view.state).toBe('interrupted');
      expect(view.tasks[0]).toMatchObject({ state: 'waiting', reason: 'interrupted' });
      // Nothing new started after the stop.
      await expect(s.builds.plan('garden')).rejects.toMatchObject({ code: 'task.stopping' });
    } finally {
      await after.builds.shutdown();
      await after.tasks.shutdown();
    }
  });

  it('a cancel followed at once by a server stop is kept: recover() makes the build cancelled, not resumable (step 33)', async () => {
    const s = setup({ script: slow });
    const id = await planned(s);
    await s.builds.start(id, start(PLAN, { limit: 1 }));
    await until(() => s.tasks.activeIds().length === 1);
    // The cancel is asked, and the server stops before the loop records it.
    const buildStore = new BuildStore(buildsRoot(world.home));
    // The round waits (the slow script): nothing else writes the record meanwhile.
    const before = JSON.stringify(await buildStore.load(id));
    const asked = await s.builds.cancel(id);
    expect(asked.cancelling).toBe(true);
    // The cancel is in a file of its own; build.json is not written by it (review of step 33, B, I1).
    expect(await buildStore.cancelMarked(id)).toBe(true);
    expect(JSON.parse(JSON.stringify(await buildStore.load(id))).updatedAt).toBe(JSON.parse(before).updatedAt);
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    const after = setup();
    try {
      expect(await after.builds.recover()).toBe(1);
      const view = await after.builds.get(id);
      expect(view.state).toBe('cancelled');
      expect(await buildStore.cancelMarked(id)).toBe(false);
      expect(view.tasks[0]?.state).toBe('cancelled');
      await expect(after.builds.resume(id)).rejects.toMatchObject({ code: 'build.wrongState' });
    } finally {
      await after.builds.shutdown();
      await after.tasks.shutdown();
    }
  });

  it('a server stop during a build\'s checks ends them at once (B1)', async () => {
    let began = false;
    const blocking: TaskChecks = {
      commands: async () => [],
      run: (_worktree, commands, signal) =>
        new Promise<CheckResult[]>((resolve) => {
          began = true;
          signal?.addEventListener('abort', () => resolve(commands.map((command) => ({ command, exitCode: null, timedOut: false, output: '', durationMs: 1 }))), { once: true });
        }),
    };
    const s = setup({ checks: blocking });
    const id = await planned(s);
    await s.builds.start(id, start(PLAN, { limit: 1 }));
    await until(() => began);
    const at = Date.now();
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    expect(Date.now() - at).toBeLessThan(10_000);
    // The record is left as an abrupt stop leaves it: running, for the next start's recover().
    const view = await s.builds.get(id);
    expect(view.state).toBe('running');
    expect(view.tasks[0]?.state).toBe('running');
  });

  it('a full shared limit makes the build wait for a free place, not fail its tasks (I2)', async () => {
    const others: string[] = [];
    const s = setup({ others, maxActive: 1 });
    try {
      const id = await planned(s);
      others.push('creation-1');
      await s.builds.start(id, start(PLAN, { limit: 1 }));
      await until(async () => (await s.builds.get(id)).waitingSlot === true);
      let view = await s.builds.get(id);
      expect(view.tasks[0]?.state).toBe('running');
      expect(view.tasks[0]?.taskId).toBeUndefined();
      others.length = 0;
      await s.builds.idle(id);
      view = await s.builds.get(id);
      expect(view.waitingSlot).toBeUndefined();
      expect(view.tasks[0]).toMatchObject({ state: 'applied' });
      expect(view.state).toBe('finished');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a stop while the build waits for a free place ends the wait at once (I2, B1)', async () => {
    const others: string[] = [];
    const s = setup({ others, maxActive: 1 });
    const id = await planned(s);
    others.push('creation-1');
    await s.builds.start(id, start(PLAN, { limit: 1 }));
    await until(async () => (await s.builds.get(id)).waitingSlot === true);
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    expect((await s.builds.get(id)).tasks[0]?.state).toBe('running');
  });

  it('a build that never started can be discarded, and the project is free again; a started one cannot here (I4)', async () => {
    const s = setup({ plan: new Error('no queue') });
    try {
      const failed = await s.builds.plan('garden');
      await s.builds.idle(failed.id);
      expect((await s.builds.get(failed.id)).state).toBe('planFailed');
      expect(await s.builds.holder('garden')).toBe(failed.id);
      expect((await s.builds.discard(failed.id)).state).toBe('discarded');
      expect(await s.builds.holder('garden')).toBeUndefined();
      await expect(s.builds.discard(failed.id)).rejects.toMatchObject({ code: 'build.wrongState' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
    const t = setup();
    try {
      const id = await planned(t);
      expect((await t.builds.discard(id)).state).toBe('discarded');
      const again = await planned(t);
      await t.builds.start(again, start(PLAN, { limit: 1 }));
      await expect(t.builds.discard(again)).rejects.toMatchObject({ code: 'build.wrongState' });
      await t.builds.idle(again);
    } finally {
      await t.builds.shutdown();
      await t.tasks.shutdown();
    }
  });

  it('after a restart, a build left planning has failed with a message in the user\'s language', async () => {
    const s = setup({ plan: PLAN });
    const store = new BuildStore(buildsRoot(world.home));
    const id = await planned(s);
    await s.builds.shutdown();
    await s.tasks.shutdown();
    const record = await store.load(id);
    await store.save({ ...(record as NonNullable<typeof record>), state: 'planning' });
    const after = setup();
    try {
      expect(await after.builds.recover()).toBe(1);
      const view = await after.builds.get(id);
      expect(view.state).toBe('planFailed');
      expect(view.error).toContain('The planner was stopped');
    } finally {
      await after.builds.shutdown();
      await after.tasks.shutdown();
    }
  });
});

/** Every task writes its file after `ms`; nothing breaks. */
const steady =
  (ms: number): TaskFakeScript =>
  (_round, prompt) => {
    const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'X';
    return { steps: [{ kind: 'wait', ms }, { kind: 'write', file: `${title.toUpperCase()}.md`, content: `${title}.\n` }, { kind: 'end', summary: `Wrote ${title}.` }] };
  };

/** Over the 5-hour threshold, its reset time counted from the moment of the reading (review of M4, M5). */
const over =
  (resetsInMs?: number) =>
  (): UsageReading => ({ kind: 'ok', fiveHour: 95, sevenDay: 10, ...(resetsInMs === undefined ? {} : { fiveHourResetsAt: new Date(Date.now() + resetsInMs).toISOString() }) });
const low: UsageReading = { kind: 'ok', fiveHour: 10, sevenDay: 10 };

const states = async (s: Setup, id: string) => (await s.builds.get(id)).tasks.map((task) => task.state);

describe('the loop (M4)', () => {
  it('pauses at the usage threshold until the reading\'s reset time, then resumes by itself', async () => {
    const s = setup({ script: steady(0), usage: [over(1500), low] });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { checks: [] }));
      await until(async () => (await s.builds.get(id)).state === 'paused');
      const paused = await s.builds.get(id);
      expect(paused.pause).toMatchObject({ reason: 'usage', fiveHour: 95, sevenDay: 10 });
      expect(Date.parse(paused.pause?.until ?? '')).toBeGreaterThan(Date.now() - 1000);
      expect(paused.tasks.every((task) => task.state === 'queued')).toBe(true);
      await until(async () => (await s.builds.get(id)).state === 'finished');
      expect(await states(s, id)).toEqual(['applied', 'applied', 'applied']);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('without a reset time it reads again after the interval; a failed reading pauses too; a login without limits never pauses', async () => {
    const s = setup({ script: steady(0), usage: [over(), { kind: 'failed', message: 'no reading' }, { kind: 'unavailable' }, low], usageRetryMs: 150 });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { checks: [], limit: 2 }));
      await until(async () => (await s.builds.get(id)).state === 'finished');
      // The third reading (no limits for this login) let task 1 start; the fourth (low) let task 2.
      expect(await states(s, id)).toEqual(['applied', 'applied', 'queued']);
      expect(s.readings).toEqual([]);
      // Read when it was due: each pause (over with no reset time, then failed) waited the interval before the next reading.
      expect(s.readAt).toHaveLength(4);
      expect((s.readAt[1] as number) - (s.readAt[0] as number)).toBeGreaterThanOrEqual(140);
      expect((s.readAt[2] as number) - (s.readAt[1] as number)).toBeGreaterThanOrEqual(140);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('the user pauses before the next task; Resume starts it without reading the usage', async () => {
    // Before task 1: no limits; after the resume the reading is skipped once; before task 3: over, so it pauses again.
    const s = setup({ script: steady(300), usage: [{ kind: 'unavailable' }, over(60_000)] });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { checks: [] }));
      await until(() => s.tasks.activeIds().length === 1);
      const pausing = await s.builds.pause(id);
      expect(pausing.pausing).toBe(true);
      await until(async () => (await s.builds.get(id)).state === 'paused');
      const paused = await s.builds.get(id);
      expect(paused.pause?.reason).toBe('user');
      expect(paused.tasks.map((task) => task.state)).toEqual(['applied', 'queued', 'queued']);
      await expect(s.builds.pause(id)).rejects.toMatchObject({ code: 'build.wrongState' });
      expect((await s.builds.resume(id)).state).toBe('running');
      await until(async () => (await s.builds.get(id)).state === 'paused');
      const again = await s.builds.get(id);
      expect(again.pause?.reason).toBe('usage');
      expect(again.tasks.map((task) => task.state)).toEqual(['applied', 'applied', 'queued']);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('cancel during a round ends it at once (the task manager\'s cancel) and leaves the integration branch as it was', async () => {
    const s = setup({ script: slow });
    try {
      const id = await planned(s);
      const started = await s.builds.start(id, start(PLAN));
      await until(() => s.tasks.activeIds().length === 1);
      const before = await integrationHead(project, started.branch);
      const at = Date.now();
      expect((await s.builds.cancel(id)).cancelling).toBe(true);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      expect(Date.now() - at).toBeLessThan(10_000);
      const view = await s.builds.get(id);
      expect(view.tasks.map((task) => task.state)).toEqual(['cancelled', 'queued', 'queued']);
      expect(view.cancelling).toBeUndefined();
      expect((await s.tasks.get(view.tasks[0]?.taskId as string)).state).toBe('cancelled');
      expect(s.tasks.activeIds()).toEqual([]);
      expect(await integrationHead(project, view.branch)).toBe(before);
      await expect(s.builds.cancel(id)).rejects.toMatchObject({ code: 'build.wrongState' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('cancel during the checks ends them', async () => {
    let began = false;
    const blocking: TaskChecks = {
      commands: async () => [],
      run: (_worktree, commands, signal) =>
        new Promise<CheckResult[]>((resolve) => {
          began = true;
          signal?.addEventListener('abort', () => resolve(commands.map((command) => ({ command, exitCode: null, timedOut: false, output: '', durationMs: 1 }))), { once: true });
        }),
    };
    const s = setup({ checks: blocking });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN));
      await until(() => began);
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      expect((await s.builds.get(id)).tasks[0]?.state).toBe('cancelled');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('cancel of a paused build needs no loop, and ends its usage pause', async () => {
    const t = setup({ script: steady(0), usage: [over(60_000)] });
    try {
      const id = await planned(t);
      await t.builds.start(id, start(PLAN));
      await until(async () => (await t.builds.get(id)).state === 'paused');
      expect((await t.builds.cancel(id)).state).toBe('cancelled');
      expect((await t.builds.get(id)).pause).toBeUndefined();
    } finally {
      await t.builds.shutdown();
      await t.tasks.shutdown();
    }
  });

  it('while the build drives its task, the user cannot act on it; a waiting task is the user\'s', async () => {
    const s = setup({ script: slow });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1 }));
      await until(async () => (await s.builds.get(id)).tasks[0]?.taskId !== undefined);
      const taskId = (await s.builds.get(id)).tasks[0]?.taskId as string;
      expect(s.builds.drives(taskId)).toBe(true);
      expect(() => s.tasks.finishRound(taskId)).toThrow(expect.objectContaining({ code: 'task.heldByBuild' }));
      await expect(s.tasks.approve(taskId)).rejects.toMatchObject({ code: 'task.heldByBuild' });
      await expect(s.tasks.discard(taskId)).rejects.toMatchObject({ code: 'task.heldByBuild' });
      await expect(s.tasks.newRound(taskId, 'More.')).rejects.toMatchObject({ code: 'task.heldByBuild' });
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      expect(s.builds.drives(taskId)).toBe(false);
      // Released: the user can handle it now (here, discard it).
      expect((await s.tasks.discard(taskId)).state).toBe('discarded');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a waiting task the user fixes and approves is applied on resume, and its skipped dependent runs', async () => {
    // Total leaves BROKEN in the build's rounds; the user's own round removes it.
    const fixable: TaskFakeScript = (round, prompt) => {
      if (prompt.includes('Remove BROKEN')) return { steps: [{ kind: 'delete', file: 'BROKEN' }, { kind: 'end', summary: 'Removed.' }] };
      return script(round, prompt);
    };
    const s = setup({ script: fixable });
    try {
      const id = await planned(s);
      await s.builds.start(id, start());
      await s.builds.idle(id);
      expect(await states(s, id)).toEqual(['applied', 'waiting', 'skipped']);
      const waiting = (await s.builds.get(id)).tasks[1]?.taskId as string;
      // The user's own round is an ordinary one: its `rm` opens the dialog, which the user allows once.
      await s.tasks.newRound(waiting, 'Remove BROKEN.');
      await until(async () => (await s.tasks.get(waiting)).pending !== undefined);
      s.tasks.answer(waiting, (await s.tasks.get(waiting)).pending?.id as string, 'once');
      await until(async () => (await s.tasks.get(waiting)).awaitingReply !== undefined);
      s.tasks.finishRound(waiting);
      await until(async () => (await s.tasks.get(waiting)).state === 'proposal');
      const approved = await s.tasks.approve(waiting);
      expect(approved.state).toBe('applied');
      await s.builds.resume(id);
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => task.state)).toEqual(['applied', 'applied', 'applied']);
      expect(done.tasks[1]?.commit).toBe(approved.applied?.commit);
      const head = await integrationHead(project, done.branch);
      expect((await gitIn(project, 'show', `${head as string}:REPORT.md`)).trim()).toBe('Report.');
      await expect(gitIn(project, 'show', `${head as string}:BROKEN`)).rejects.toBeDefined();
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('after a restart the build is interrupted; Resume goes on with the tasks that do not depend on the interrupted one', async () => {
    const s = setup({ script: slow });
    const id = await planned(s);
    await s.builds.start(id, start(PLAN, { checks: [] }));
    await until(() => s.tasks.activeIds().length === 1);
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    const after = setup();
    try {
      await after.tasks.recover();
      await after.builds.recover();
      expect((await after.builds.get(id)).state).toBe('interrupted');
      // Nothing resumes by itself.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await after.builds.get(id)).state).toBe('interrupted');
      await after.builds.resume(id);
      await after.builds.idle(id);
      const done = await after.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
        ['waiting', 'interrupted'],
        ['applied', null],
        ['applied', null],
      ]);
    } finally {
      await after.builds.shutdown();
      await after.tasks.shutdown();
    }
  });

  it('a cancel during a slow usage reading ends the build without a pause or a session (review of M4, B1)', async () => {
    let answer: ((reading: UsageReading) => void) | undefined;
    const slowReading = () => new Promise<UsageReading>((resolve) => (answer = resolve));
    const s = setup({ script: steady(0), usage: [slowReading] });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN));
      await until(() => answer !== undefined);
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      // The reading answers "over" only now: nothing pauses, nothing resumes by itself, no session started.
      answer?.(over(50)());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const view = await s.builds.get(id);
      expect(view.state).toBe('cancelled');
      expect(view.pause).toBeUndefined();
      expect(view.tasks.map((task) => task.state)).toEqual(['queued', 'queued', 'queued']);
      expect(s.runner.started).toHaveLength(0);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a pause asked during the usage reading is the user\'s: no session starts, nothing resumes by itself', async () => {
    let answer: ((reading: UsageReading) => void) | undefined;
    const slowReading = () => new Promise<UsageReading>((resolve) => (answer = resolve));
    const s = setup({ script: steady(0), usage: [slowReading] });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN));
      await until(() => answer !== undefined);
      await s.builds.pause(id);
      answer?.({ kind: 'unavailable' });
      await until(async () => (await s.builds.get(id)).state === 'paused');
      expect((await s.builds.get(id)).pause?.reason).toBe('user');
      expect(s.runner.started).toHaveLength(0);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a build paused for usage becomes the user\'s pause and no longer resumes by itself', async () => {
    const s = setup({ script: steady(0), usage: [over(300)] });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN));
      await until(async () => (await s.builds.get(id)).state === 'paused');
      await s.builds.idle(id);
      expect((await s.builds.pause(id)).pause?.reason).toBe('user');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect((await s.builds.get(id)).state).toBe('paused');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a reset time beyond 8 days is not believed: the build reads again after the interval (I3)', async () => {
    const t = setup({ script: steady(0), usage: [over(100 * 24 * 60 * 60_000)], usageRetryMs: 60_000 });
    try {
      const id = await planned(t);
      await t.builds.start(id, start(PLAN));
      await until(async () => (await t.builds.get(id)).state === 'paused');
      const view = await t.builds.get(id);
      // The interval, not the 100 days.
      expect(Date.parse(view.pause?.until ?? '') - Date.parse(view.pause?.at ?? '')).toBeLessThanOrEqual(61_000);
    } finally {
      await t.builds.shutdown();
      await t.tasks.shutdown();
    }
  });

  it('a task that could not start waits without a task of its own; Resume queues it again (I4)', async () => {
    const folder: { holder?: string } = { holder: 'a creation' };
    const s = setup({ script: steady(0), folder });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { checks: [] }));
      await s.builds.idle(id);
      const first = await s.builds.get(id);
      expect(first.tasks[0]).toMatchObject({ state: 'waiting', reason: 'notStarted' });
      expect(first.tasks[0]?.taskId).toBeUndefined();
      delete folder.holder;
      await s.builds.resume(id);
      await s.builds.idle(id);
      expect(await states(s, id)).toEqual(['applied', 'applied', 'applied']);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('the cap of rounds leaves the next task waiting and finishes the build; Resume queues it again and the cap still holds', async () => {
    const s = setup({ script: steady(0), roundsCap: 1 });
    try {
      const id = await planned(s);
      const started = await s.builds.start(id, start(PLAN, { checks: [] }));
      expect(started.settings?.maxRounds).toBe(1);
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
        ['applied', null],
        ['waiting', 'roundsCap'],
        ['queued', null],
      ]);
      await s.builds.resume(id);
      await s.builds.idle(id);
      expect((await s.builds.get(id)).tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
        ['applied', null],
        ['waiting', 'roundsCap'],
        ['queued', null],
      ]);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

describe('the build page\'s actions (M5)', () => {
  it('apply waits for the user\'s waiting tasks, then lands the whole build as one commit in the user\'s folder, with a line in the note; revert undoes it', async () => {
    await world.initLibrary();
    const s = setup();
    try {
      const before = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
      const id = await planned(s);
      expect(await s.builds.diff(id)).toEqual({ diff: null });
      await expect(s.builds.apply(id, before)).rejects.toMatchObject({ code: 'build.wrongState' });
      await s.builds.start(id, start());
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => task.state)).toEqual(['applied', 'waiting', 'skipped']);
      // The page sees the waiting task's own checks.
      expect(done.tasks[1]?.task).toMatchObject({ state: 'proposal', checks: [{ command: 'npm test', exitCode: 1, timedOut: false }], codexCalls: 0, codexTokens: 0 });
      // Claude's tokens per task (the user's decision 2, step 33): each fake round reports FAKE_USAGE; summed over the rounds.
      const rounds2 = done.tasks[1]?.rounds ?? 0;
      expect(rounds2).toBe(2);
      const perRound = FAKE_USAGE.input + FAKE_USAGE.output;
      expect(done.tasks[1]?.task?.claudeTokens).toEqual({ noCache: perRound * 2, withCache: (perRound + FAKE_USAGE.cacheRead + FAKE_USAGE.cacheCreation) * 2, rounds: 2 });
      expect(done.tasks[0]?.task?.claudeTokens).toEqual({ noCache: perRound, withCache: perRound + FAKE_USAGE.cacheRead + FAKE_USAGE.cacheCreation, rounds: 1 });
      // A task that never started has no task of its own, and no tokens.
      expect(done.tasks[2]?.task).toBeUndefined();
      // The cumulative diff: task 1's file only, and the head it shows.
      const shown = await s.builds.diff(id);
      expect(shown.diff?.files.map((file) => [file.path, file.status])).toEqual([['LIST.md', 'added']]);
      expect(shown.head).toBe(done.tasks[0]?.commit);
      const head = shown.head as string;
      // Task 2 waits for the user: no apply until it is approved or discarded.
      await expect(s.builds.apply(id, head)).rejects.toMatchObject({ code: 'build.openTasks', params: { tasks: [2] } });
      await s.tasks.discard(done.tasks[1]?.taskId as string);
      // A dirty folder is refused, as for a task.
      await writeTree(project, { 'DIRTY.md': 'x\n' });
      await expect(s.builds.apply(id, head)).rejects.toMatchObject({ code: 'task.dirtyFolder' });
      await rm(path.join(project, 'DIRTY.md'));
      const applied = await s.builds.apply(id, head);
      expect(applied.state).toBe('applied');
      const commit = applied.applied?.commit as string;
      expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(commit);
      expect((await gitIn(project, 'rev-parse', 'HEAD^')).trim()).toBe(before);
      expect((await gitIn(project, 'log', '-1', '--format=%B')).trim()).toContain(`Build ${id}: 1 task from the project's brief`);
      expect(await readFile(path.join(project, 'LIST.md'), 'utf8')).toBe('List.\n');
      expect(await gitIn(project, 'status', '--porcelain')).toBe('');
      expect(await readFile(path.join(world.library, 'projects', 'garden.md'), 'utf8')).toContain(`Build applied: 1 task (commit ${commit.slice(0, 7)}, build ${id}).`);
      // Applied: the project is free again; the diff is the applied commit's.
      expect(await s.builds.holder('garden')).toBeUndefined();
      expect((await s.builds.diff(id)).diff?.files.map((file) => file.path)).toEqual(['LIST.md']);
      await expect(s.builds.apply(id, head)).rejects.toMatchObject({ code: 'build.wrongState' });
      // Revert has the same refusals.
      await writeTree(project, { 'DIRTY.md': 'x\n' });
      await expect(s.builds.revert(id)).rejects.toMatchObject({ code: 'task.dirtyFolder' });
      await rm(path.join(project, 'DIRTY.md'));
      const reverted = await s.builds.revert(id);
      expect(reverted.state).toBe('reverted');
      expect((await gitIn(project, 'rev-parse', 'HEAD^')).trim()).toBe(commit);
      await expect(access(path.join(project, 'LIST.md'))).rejects.toBeDefined();
      await expect(s.builds.revert(id)).rejects.toMatchObject({ code: 'build.wrongState' });
      // The integration branch stays after the apply and the revert (the user's decision 1, step 33)…
      expect(await integrationHead(project, done.branch)).toBe(head);
      // …and discarding the reverted build removes only it: the commits on the default branch and the record stay.
      const headNow = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
      const gone = await s.builds.discard(id);
      expect(gone.state).toBe('discarded');
      expect(gone.applied?.commit).toBe(commit);
      expect(gone.reverted?.commit).toBe(reverted.reverted?.commit);
      expect(await integrationHead(project, done.branch)).toBeUndefined();
      expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(headNow);
      expect(await gitIn(project, 'status', '--porcelain')).toBe('');
      await expect(s.builds.discard(id)).rejects.toMatchObject({ code: 'build.wrongState' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('an applied build can be discarded: only its branch goes, never under a folder that has it checked out (the user\'s decision 1, step 33)', async () => {
    await world.initLibrary();
    const s = setup();
    try {
      const id = await planned(s);
      await s.builds.start(id, start());
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      await s.tasks.discard(done.tasks[1]?.taskId as string);
      const { head } = await s.builds.diff(id);
      const applied = await s.builds.apply(id, head as string);
      const commit = applied.applied?.commit as string;
      expect(await integrationHead(project, done.branch)).toBe(head);
      // The build's branch checked out in another worktree of the repository: discard refuses and removes nothing (step 33).
      const other = path.join(world.dir, 'other-worktree');
      await gitIn(project, 'worktree', 'add', '--quiet', other, done.branch);
      await expect(s.builds.discard(id)).rejects.toMatchObject({ code: 'build.branchCheckedOut' });
      expect(await integrationHead(project, done.branch)).toBe(head);
      await gitIn(project, 'worktree', 'remove', '--force', other);
      const gone = await s.builds.discard(id);
      expect(gone).toMatchObject({ state: 'discarded', applied: { commit } });
      expect(await integrationHead(project, done.branch)).toBeUndefined();
      expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(commit);
      expect(await readFile(path.join(project, 'LIST.md'), 'utf8')).toBe('List.\n');
      // Still revertable: the revert needs only the applied commit (review of step 33, A, I-1). The build stays discarded.
      expect((await s.builds.diff(id)).diff?.files.map((file) => file.path)).toEqual(['LIST.md']);
      const reverted = await s.builds.revert(id);
      expect(reverted).toMatchObject({ state: 'discarded', applied: { commit } });
      expect(reverted.reverted?.commit).toBe((await gitIn(project, 'rev-parse', 'HEAD')).trim());
      await expect(access(path.join(project, 'LIST.md'))).rejects.toBeDefined();
      await expect(s.builds.revert(id)).rejects.toMatchObject({ code: 'build.wrongState' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('discard removes the integration branch and every open task of the build; nothing reaches the folder', async () => {
    const s = setup();
    try {
      const before = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
      const id = await planned(s);
      await s.builds.start(id, start());
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      const waiting = done.tasks[1]?.taskId as string;
      expect(await integrationHead(project, done.branch)).toBeDefined();
      // The user checked the build's branch out by hand: discard refuses, and removes nothing (review of M5, minor).
      const main = (await gitIn(project, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
      await gitIn(project, 'checkout', '--quiet', done.branch);
      await expect(s.builds.discard(id)).rejects.toMatchObject({ code: 'build.branchCheckedOut' });
      expect(await integrationHead(project, done.branch)).toBeDefined();
      expect((await s.tasks.get(waiting)).state).not.toBe('discarded');
      await gitIn(project, 'checkout', '--quiet', main);
      const discarded = await s.builds.discard(id);
      expect(discarded.state).toBe('discarded');
      expect(await integrationHead(project, done.branch)).toBeUndefined();
      expect((await s.tasks.get(waiting)).state).toBe('discarded');
      expect(await s.builds.holder('garden')).toBeUndefined();
      expect(await s.builds.diff(id)).toEqual({ diff: null });
      expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(before);
      expect(await gitIn(project, 'status', '--porcelain')).toBe('');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a skip carries over: a task skipped for a skipped one is skipped too, and Resume skips both again (review of M4, minor; step 33)', async () => {
    const chain: PlanOutput = { ...PLAN, tasks: [...PLAN.tasks, { title: 'Final', instruction: 'Write FINAL.md from the report.', doneWhen: 'FINAL.md exists.', dependsOn: [3] }] };
    const s = setup({ plan: chain });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(chain, { fixRounds: 0 }));
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => [task.state, task.skippedFor ?? null])).toEqual([
        ['applied', null],
        ['waiting', null],
        ['skipped', 2],
        ['skipped', 3],
      ]);
      await s.builds.resume(id);
      await s.builds.idle(id);
      const again = await s.builds.get(id);
      expect(again.state).toBe('finished');
      expect(again.tasks.map((task) => [task.state, task.skippedFor ?? null])).toEqual([
        ['applied', null],
        ['waiting', null],
        ['skipped', 2],
        ['skipped', 3],
      ]);
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a change already on the default branch says so with its own code, not "nothing to apply" (review of M5, minor; step 33)', async () => {
    await world.initLibrary();
    const s = setup();
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1 }));
      await s.builds.idle(id);
      const { head } = await s.builds.diff(id);
      // As if a server stop had come after the change landed on main and before `applied` was saved.
      await gitIn(project, 'merge', '--ff-only', '--quiet', head as string);
      await expect(s.builds.apply(id, head as string)).rejects.toMatchObject({ code: 'build.alreadyOnBranch', params: { branch: 'main' } });
      expect((await s.builds.get(id)).state).toBe('finished');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('apply, discard and revert are refused while the build runs or a task of it works', async () => {
    const s = setup({ script: slow });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1 }));
      await until(() => s.tasks.activeIds().length === 1);
      const base = (await s.builds.get(id)).baseCommit as string;
      await expect(s.builds.apply(id, base)).rejects.toMatchObject({ code: 'build.wrongState' });
      await expect(s.builds.discard(id)).rejects.toMatchObject({ code: 'build.wrongState' });
      await expect(s.builds.revert(id)).rejects.toMatchObject({ code: 'build.wrongState' });
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      // Cancelled with nothing applied: nothing to apply; the cancelled task is discarded with the build.
      await expect(s.builds.apply(id, base)).rejects.toMatchObject({ code: 'build.nothingToApply' });
      const taskId = (await s.builds.get(id)).tasks[0]?.taskId as string;
      expect((await s.builds.discard(id)).state).toBe('discarded');
      expect((await s.tasks.get(taskId)).state).toBe('discarded');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a waiting task the user approved counts in the applied build: its commit message and the page (review of M5, I1)', async () => {
    const fixable: TaskFakeScript = (round, prompt) => {
      if (prompt.includes('Remove BROKEN')) return { steps: [{ kind: 'delete', file: 'BROKEN' }, { kind: 'end', summary: 'Removed.' }] };
      return script(round, prompt);
    };
    const s = setup({ script: fixable });
    try {
      const id = await planned(s);
      await s.builds.start(id, start());
      await s.builds.idle(id);
      const waiting = (await s.builds.get(id)).tasks[1]?.taskId as string;
      await s.tasks.newRound(waiting, 'Remove BROKEN.');
      await until(async () => (await s.tasks.get(waiting)).pending !== undefined);
      s.tasks.answer(waiting, (await s.tasks.get(waiting)).pending?.id as string, 'once');
      await until(async () => (await s.tasks.get(waiting)).awaitingReply !== undefined);
      s.tasks.finishRound(waiting);
      await until(async () => (await s.tasks.get(waiting)).state === 'proposal');
      await s.tasks.approve(waiting);
      const head = (await s.builds.diff(id)).head as string;
      const applied = await s.builds.apply(id, head);
      expect(applied.tasks.map((task) => task.state)).toEqual(['applied', 'applied', 'skipped']);
      const message = (await gitIn(project, 'log', '-1', '--format=%B')).trim();
      expect(message).toContain(`Build ${id}: 2 tasks from the project's brief`);
      expect(message).toContain('- Total');
      expect((await gitIn(project, 'show', 'HEAD:TOTAL.md')).trim()).toBe('Total.');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('apply refuses a branch that is not the one the page showed, or that holds a commit briefstack did not make (review of M5, I2)', async () => {
    const s = setup();
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1 }));
      await s.builds.idle(id);
      const build = await s.builds.get(id);
      const head = (await s.builds.diff(id)).head as string;
      // The page showed an older head (the base).
      await expect(s.builds.apply(id, build.baseCommit as string)).rejects.toMatchObject({ code: 'build.branchMoved' });
      // Someone added a commit to the branch outside briefstack: the page would show it, but briefstack did not make it.
      const tree = (await gitIn(project, 'rev-parse', `${head}^{tree}`)).trim();
      const foreign = (await gitIn(project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit-tree', tree, '-p', head, '-m', 'by hand')).trim();
      await gitIn(project, 'update-ref', `refs/heads/${build.branch}`, foreign, head);
      expect((await s.builds.diff(id)).head).toBe(foreign);
      await expect(s.builds.apply(id, foreign)).rejects.toMatchObject({ code: 'build.branchMoved' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('apply refuses a commit added by hand below one briefstack made later (review of M6, I-1)', async () => {
    const fixable: TaskFakeScript = (round, prompt) => {
      if (prompt.includes('Remove BROKEN')) return { steps: [{ kind: 'delete', file: 'BROKEN' }, { kind: 'end', summary: 'Removed.' }] };
      return script(round, prompt);
    };
    const s = setup({ script: fixable });
    try {
      const id = await planned(s);
      await s.builds.start(id, start());
      await s.builds.idle(id);
      const build = await s.builds.get(id);
      const waiting = build.tasks[1]?.taskId as string;
      // A commit by hand on the branch, then the user's approval of the waiting task lands on top of it.
      const head = (await s.builds.diff(id)).head as string;
      const tree = (await gitIn(project, 'rev-parse', `${head}^{tree}`)).trim();
      const foreign = (await gitIn(project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit-tree', tree, '-p', head, '-m', 'by hand')).trim();
      await gitIn(project, 'update-ref', `refs/heads/${build.branch}`, foreign, head);
      await s.tasks.newRound(waiting, 'Remove BROKEN.');
      await until(async () => (await s.tasks.get(waiting)).pending !== undefined);
      s.tasks.answer(waiting, (await s.tasks.get(waiting)).pending?.id as string, 'once');
      await until(async () => (await s.tasks.get(waiting)).awaitingReply !== undefined);
      s.tasks.finishRound(waiting);
      await until(async () => (await s.tasks.get(waiting)).state === 'proposal');
      await s.tasks.approve(waiting);
      const top = (await s.builds.diff(id)).head as string;
      // The head is briefstack's own commit, but the one below it is not.
      expect((await gitIn(project, 'rev-parse', `${top}^1`)).trim()).toBe(foreign);
      await expect(s.builds.apply(id, top)).rejects.toMatchObject({ code: 'build.branchMoved' });
      expect((await s.builds.get(id)).state).toBe('finished');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a task the build cancelled after its round, approved by the user since, counts as applied (review of M6, I-1)', async () => {
    let began = false;
    const blocking: TaskChecks = {
      commands: async () => [],
      run: (_worktree, commands, signal) =>
        new Promise<CheckResult[]>((resolve) => {
          began = true;
          signal?.addEventListener('abort', () => resolve(commands.map((command) => ({ command, exitCode: null, timedOut: false, output: '', durationMs: 1 }))), { once: true });
        }),
    };
    const s = setup({ checks: blocking });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN));
      await until(() => began);
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      const build = await s.builds.get(id);
      expect(build.tasks[0]?.state).toBe('cancelled');
      const taskId = build.tasks[0]?.taskId as string;
      // Its checks ended with the cancel: the task is back to its proposal.
      await until(async () => (await s.tasks.get(taskId)).state === 'proposal');
      // The build no longer drives it: the user approves it onto the integration branch.
      await s.tasks.approve(taskId);
      const applied = await s.builds.apply(id, (await s.builds.diff(id)).head as string);
      expect(applied.state).toBe('applied');
      expect(applied.tasks[0]?.state).toBe('applied');
      expect(await readFile(path.join(project, 'LIST.md'), 'utf8')).toBe('List.\n');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('when the project\'s branch moved: a conflicting change is refused; another change is combined (three-way)', async () => {
    const s = setup();
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1 }));
      await s.builds.idle(id);
      const head = (await s.builds.diff(id)).head as string;
      // The user committed LIST.md with other content on main meanwhile: a conflict.
      await writeTree(project, { 'LIST.md': 'Mine.\n' });
      await commitAll(project, 'my list');
      await expect(s.builds.apply(id, head)).rejects.toMatchObject({ code: 'task.conflict' });
      expect((await s.builds.get(id)).state).toBe('finished');
      // Undone, and another file committed instead: the build lands on top of it.
      await gitIn(project, 'reset', '--hard', '--quiet', 'HEAD~1');
      await writeTree(project, { 'OTHER.md': 'Other.\n' });
      const mine = await commitAll(project, 'other file');
      const applied = await s.builds.apply(id, head);
      expect(applied.state).toBe('applied');
      expect((await gitIn(project, 'rev-parse', 'HEAD^')).trim()).toBe(mine);
      expect(await readFile(path.join(project, 'OTHER.md'), 'utf8')).toBe('Other.\n');
      expect(await readFile(path.join(project, 'LIST.md'), 'utf8')).toBe('List.\n');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('apply and discard wait while the user\'s own round on a waiting task works (build.taskRunning)', async () => {
    const asking: TaskFakeScript = (round, prompt) => (prompt.includes('Look again') ? { steps: [{ kind: 'shell', command: 'npm test' }, { kind: 'end', summary: 'Looked.' }] } : script(round, prompt));
    const s = setup({ script: asking });
    try {
      const id = await planned(s);
      await s.builds.start(id, start());
      await s.builds.idle(id);
      const waiting = (await s.builds.get(id)).tasks[1]?.taskId as string;
      const head = (await s.builds.diff(id)).head as string;
      // The user's round asks a command: it waits on the dialog, running.
      await s.tasks.newRound(waiting, 'Look again.');
      await until(async () => (await s.tasks.get(waiting)).pending !== undefined);
      await expect(s.builds.apply(id, head)).rejects.toMatchObject({ code: 'build.taskRunning', params: { task: waiting } });
      await expect(s.builds.discard(id)).rejects.toMatchObject({ code: 'build.taskRunning' });
      s.tasks.cancel(waiting);
      await until(async () => (await s.tasks.get(waiting)).state === 'cancelled');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a task the build cancelled is discarded with the apply', async () => {
    const slowTotal: TaskFakeScript = (round, prompt) => (/The task: Total/.test(prompt) ? slow(round, prompt) : script(round, prompt));
    const s = setup({ script: slowTotal });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 2, checks: [] }));
      await until(async () => (await s.builds.get(id)).tasks[1]?.taskId !== undefined);
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      const build = await s.builds.get(id);
      expect(build.tasks.map((task) => task.state)).toEqual(['applied', 'cancelled', 'queued']);
      const cancelled = build.tasks[1]?.taskId as string;
      expect((await s.tasks.get(cancelled)).state).toBe('cancelled');
      expect((await s.builds.apply(id, (await s.builds.diff(id)).head as string)).state).toBe('applied');
      expect((await s.tasks.get(cancelled)).state).toBe('discarded');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

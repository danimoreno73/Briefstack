import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrationHead } from '../../src/builds/git.js';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import type { PlanOutput } from '../../src/builds/types.js';
import type { UsageReading } from '../../src/builds/usage.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript, type TaskFakeStep } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import type { CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit } from '../helpers.js';
import { gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

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
  readings: UsageReading[];
}

interface SetupOptions {
  plan?: PlanOutput | Error;
  usage?: UsageReading[];
  script?: TaskFakeScript;
  /** Other sessions holding places in the shared limit as the task manager sees it (creations), changed by the test. */
  others?: string[];
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
    ...(others === undefined ? {} : { creations: { activeIds: () => others, folderHolder: () => undefined } }),
  });
  const planner = new FakeBuildPlanner(options.plan ?? PLAN);
  const readings = [...(options.usage ?? [])];
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => maxActive,
    ...(options.usage === undefined ? {} : { usage: async () => readings.shift() ?? { kind: 'unavailable' } }),
    usageRetryMs: options.usageRetryMs ?? 60_000,
    slotRetryMs: 20,
  });
  holder.builds = builds;
  return { builds, tasks, runner, planner, runs, readings };
}

const start = (plan: PlanOutput = PLAN, overrides: Partial<BuildStartInput> = {}): BuildStartInput => ({
  tasks: plan.tasks,
  limit: plan.tasks.length,
  commands: plan.commands,
  checks: plan.checks,
  fixRounds: 1,
  thresholds: { fiveHour: 80, week: 90 },
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
      expect(done.state).toBe('finished');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

/** Polls until `check` holds, or fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
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

const over = (resetsInMs?: number): UsageReading => ({ kind: 'ok', fiveHour: 95, sevenDay: 10, ...(resetsInMs === undefined ? {} : { fiveHourResetsAt: new Date(Date.now() + resetsInMs).toISOString() }) });
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
      await until(async () => (await s.builds.get(id)).pause?.reason === 'usage');
      const first = await s.builds.get(id);
      expect(Date.parse(first.pause?.until ?? '') - Date.parse(first.pause?.at ?? '')).toBeLessThan(1000);
      await until(async () => (await s.builds.get(id)).pause?.reason === 'usageUnread');
      await until(async () => (await s.builds.get(id)).state === 'finished');
      // The third reading (no limits for this login) let task 1 start; the fourth (low) let task 2.
      expect(await states(s, id)).toEqual(['applied', 'applied', 'queued']);
      expect(s.readings).toEqual([]);
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

  it('the cap of rounds leaves the next task waiting and finishes the build', async () => {
    const store = new BuildStore(buildsRoot(world.home));
    const s = setup({ script: steady(400) });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { checks: [] }));
      await until(async () => (await s.builds.get(id)).tasks[0]?.taskId !== undefined);
      // While task 1 works (nothing is saved meanwhile), the cap is lowered to one round.
      const record = await store.load(id);
      await store.save({ ...(record as NonNullable<typeof record>), settings: { ...(record?.settings as NonNullable<NonNullable<typeof record>['settings']>), maxRounds: 1 } });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
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

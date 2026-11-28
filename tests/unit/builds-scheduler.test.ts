import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrationHead } from '../../src/builds/git.js';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import type { PlanOutput, QueueItem } from '../../src/builds/types.js';
import type { UsageReading } from '../../src/builds/usage.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript, type TaskFakeStep } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import type { CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit } from '../helpers.js';
import { gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// The scheduler of a build with several slots (BRIEF-phase-11 §2, 4–9 and
// §3; PLAN-phase-11 M3), over the fake planner and the fake task runner on a
// temp git repository. Phase 9's tests (builds-manager.test.ts) hold one slot.

useHermeticGit();

let world: TaskWorld;
let project: string;

/**
 * A round reads its card's instruction: `WAIT <ms>` and `WRITE <file>: <text>`
 * lines; in the card's redo (its prompt says so) `REDO-WAIT` and `REDO-WRITE`
 * lines instead, when it has them.
 */
const script: TaskFakeScript = (_round, prompt) => {
  const redo = prompt.includes('being done a second time');
  const lines = (tag: string) => [...prompt.matchAll(new RegExp(`^${tag} (.+)$`, 'gm'))].map((match) => match[1] as string);
  const waitTag = redo && lines('REDO-WAIT').length > 0 ? 'REDO-WAIT' : 'WAIT';
  const writeTag = redo && lines('REDO-WRITE').length > 0 ? 'REDO-WRITE' : 'WRITE';
  const steps: TaskFakeStep[] = [
    ...lines(waitTag).map((ms): TaskFakeStep => ({ kind: 'wait', ms: Number(ms) })),
    ...lines(writeTag).map((line): TaskFakeStep => {
      const [file, ...text] = line.split(': ');
      return { kind: 'write', file: file as string, content: `${text.join(': ')}\n` };
    }),
    { kind: 'end', summary: 'Done.' },
  ];
  return { steps };
};

const cardOf = (title: string, instruction: string, area: string[] | undefined, dependsOn: number[] = []): QueueItem => ({
  title,
  instruction,
  doneWhen: 'Done.',
  dependsOn,
  ...(area === undefined ? {} : { area }),
});

interface Setup {
  builds: BuildManager;
  tasks: TaskManager;
  runner: TaskFakeRunner;
  readAt: number[];
  /** The most task sessions or checks seen at work at once. */
  peak: () => number;
  stopWatching: () => void;
}

function setup(plan: PlanOutput, options: { maxActive?: number; checks?: TaskChecks; usage?: UsageReading[] } = {}): Setup {
  const holder: { builds?: BuildManager } = {};
  const runner = new TaskFakeRunner({ script });
  const maxActive = options.maxActive ?? 4;
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
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    buildOn: (slug) => holder.builds?.holder(slug),
    buildDrives: (id) => holder.builds?.drives(id) ?? false,
  });
  const readings = [...(options.usage ?? [])];
  const readAt: number[] = [];
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner: new FakeBuildPlanner(plan),
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
            return readings.shift() ?? { kind: 'unavailable' };
          },
        }),
    usageRetryMs: 60_000,
    slotRetryMs: 20,
  });
  holder.builds = builds;
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, tasks.activeIds().length)), 5);
  return { builds, tasks, runner, readAt, peak: () => peak, stopWatching: () => clearInterval(timer) };
}

async function close(s: Setup): Promise<void> {
  s.stopWatching();
  await s.builds.shutdown();
  await s.tasks.shutdown();
}

const startOf = (plan: PlanOutput, overrides: Partial<BuildStartInput> = {}): BuildStartInput => ({
  tasks: plan.tasks,
  limit: plan.tasks.length,
  commands: ['npm test'],
  checks: [],
  noChecks: true,
  fixRounds: 0,
  thresholds: { fiveHour: 80, week: 90 },
  slots: 2,
  ...overrides,
});

async function startBuild(s: Setup, plan: PlanOutput, overrides: Partial<BuildStartInput> = {}): Promise<string> {
  const build = await s.builds.plan('garden');
  await s.builds.idle(build.id);
  await s.builds.start(build.id, startOf(plan, overrides));
  return build.id;
}

async function until(check: () => boolean | Promise<boolean>, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const states = async (s: Setup, id: string) => (await s.builds.get(id)).tasks.map((task) => [task.state, task.reason ?? null]);

const plan = (tasks: QueueItem[]): PlanOutput => ({ tasks, commands: ['npm test'], checks: [] });

/** Checks that fail where `fails` says, for the files of the folder they run in. */
function fileChecks(fails: (files: Record<string, string>) => boolean): { checks: TaskChecks; runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    checks: {
      commands: async () => [],
      run: async (dir, commands): Promise<CheckResult[]> => {
        const files: Record<string, string> = {};
        for (const name of ['A.md', 'B.md', 'C.md']) {
          const text = await readFile(path.join(dir, name), 'utf8').catch(() => undefined);
          if (text !== undefined) files[name] = text.trim();
        }
        runs.push(path.basename(dir));
        const failed = fails(files);
        return commands.map((command) => ({ command, exitCode: failed ? 1 : 0, timedOut: false, output: failed ? 'FAIL together' : 'ok', durationMs: 1 }));
      },
    },
  };
}

beforeEach(async () => {
  world = await taskWorld('builds-scheduler');
  project = await world.project('garden', { 'docs/BRIEF.md': '# Garden\n\n- Cards.\n' });
});
afterEach(() => world.cleanup());

// Each test runs whole builds over real git (one test, two in a row): on the
// Windows CI runner some took close to the 30 s default, and one passed it.
const SLOW = { timeout: 90_000 };

describe('cards at once', SLOW, () => {
  it('two cards of separate areas run at the same time and both join; the second is checked again on the joined tree', async () => {
    const board = plan([cardOf('Alpha', 'WAIT 400\nWRITE A.md: a', ['A.md']), cardOf('Beta', 'WAIT 400\nWRITE B.md: b', ['B.md'])]);
    const files = fileChecks(() => false);
    const s = setup(board, { checks: files.checks });
    try {
      const id = await startBuild(s, board, { checks: ['npm test'], noChecks: false });
      await s.builds.idle(id);
      expect(await states(s, id)).toEqual([
        ['applied', null],
        ['applied', null],
      ]);
      expect(s.peak()).toBe(2);
      const done = await s.builds.get(id);
      // One card joined on the head it started at, the other merged onto the moved head and checked there.
      expect(done.tasks.map((task) => task.join?.merged).sort()).toEqual([false, true]);
      expect(files.runs.filter((dir) => dir === 'join')).toHaveLength(1);
      const head = (await integrationHead(project, done.branch)) as string;
      expect((await gitIn(project, 'show', `${head}:A.md`)).trim()).toBe('a');
      expect((await gitIn(project, 'show', `${head}:B.md`)).trim()).toBe('b');
      expect(done.state).toBe('finished');
    } finally {
      await close(s);
    }
  });

  it('cards whose areas overlap, or have none, never run at the same time; priority is the board\'s order', async () => {
    const board = plan([
      cardOf('One', 'WAIT 200\nWRITE A.md: one', ['src/']),
      cardOf('Two', 'WAIT 200\nWRITE B.md: two', ['src/report/x.ts']),
      cardOf('Three', 'WAIT 200\nWRITE C.md: three', undefined),
    ]);
    const s = setup(board);
    try {
      const id = await startBuild(s, board, { slots: 3 });
      await s.builds.idle(id);
      expect(s.peak()).toBe(1);
      expect(s.runner.started.map((round) => /The task: (\w+)/.exec(round.prompt)?.[1])).toEqual(['One', 'Two', 'Three']);
      expect(await states(s, id)).toEqual([
        ['applied', null],
        ['applied', null],
        ['applied', null],
      ]);
    } finally {
      await close(s);
    }
  });

  it('fills free slots in priority order, waits for dependencies, and keeps to the slots and the shared limit', async () => {
    const board = plan([
      cardOf('One', 'WAIT 300\nWRITE A.md: 1', ['a/']),
      cardOf('Two', 'WAIT 300\nWRITE B.md: 2', ['b/']),
      cardOf('Three', 'WAIT 100\nWRITE C.md: 3', ['c/']),
      cardOf('Four', 'WRITE D.md: 4', ['d/'], [1]),
    ]);
    const s = setup(board);
    try {
      const id = await startBuild(s, board);
      await until(() => s.tasks.activeIds().length === 2);
      // The first two in order; Three waits for a slot, Four for One.
      expect((await s.builds.get(id)).tasks.map((task) => task.state)).toEqual(['running', 'running', 'queued', 'queued']);
      await s.builds.idle(id);
      expect(s.peak()).toBe(2);
      // Priority picks which cards start in a pass; which of the two opens its session first is git's timing (seen on CI).
      expect(
        s.runner.started
          .map((round) => /The task: (\w+)/.exec(round.prompt)?.[1])
          .slice(0, 2)
          .sort(),
      ).toEqual(['One', 'Two']);
      expect(await states(s, id)).toEqual([
        ['applied', null],
        ['applied', null],
        ['applied', null],
        ['applied', null],
      ]);
      // A finished build holds the project: discarded, so the next one can start.
      await s.builds.discard(id);
    } finally {
      await close(s);
    }
    // A shared limit of one: two slots run one card at a time, the other waiting for a place.
    const t = setup(board, { maxActive: 1 });
    try {
      const id = await startBuild(t, board);
      await until(async () => (await t.builds.get(id)).waitingSlot === true);
      await t.builds.idle(id);
      expect(t.peak()).toBe(1);
      // Each card's state, reason and detail, so a failure says which card did not land and why (seen once on Linux CI,
      // run 46158526397, as a bare false; 20/20 locally).
      const done = await t.builds.get(id);
      expect(done.tasks.map((task) => [task.state, task.reason ?? null, task.detail ?? null])).toEqual(done.tasks.map(() => ['applied', null, null]));
    } finally {
      await close(t);
    }
  });
});

describe('pauses, cancel and restart with cards at work', SLOW, () => {
  const three = plan([cardOf('One', 'WAIT 300\nWRITE A.md: 1', ['a/']), cardOf('Two', 'WAIT 600\nWRITE B.md: 2', ['b/']), cardOf('Three', 'WRITE C.md: 3', ['c/'])]);

  it('over the usage threshold no card starts, those at work finish, then the build pauses', async () => {
    const over: UsageReading = { kind: 'ok', fiveHour: 95, sevenDay: 10 };
    const s = setup(three, { usage: [{ kind: 'unavailable' }, over, over] });
    try {
      const id = await startBuild(s, three);
      await until(async () => (await s.builds.get(id)).state === 'paused');
      const paused = await s.builds.get(id);
      expect(paused.pause).toMatchObject({ reason: 'usage', fiveHour: 95 });
      expect(paused.tasks.map((task) => task.state)).toEqual(['applied', 'applied', 'queued']);
      // One reading for the first two cards, then one each time a card ended and Three could have started.
      expect(s.readAt).toHaveLength(3);
      expect(s.peak()).toBe(2);
    } finally {
      await close(s);
    }
  });

  it('the user\'s pause lets the cards at work finish, then pauses; Resume goes on', async () => {
    const s = setup(three);
    try {
      const id = await startBuild(s, three);
      await until(() => s.tasks.activeIds().length === 2);
      expect((await s.builds.pause(id)).pausing).toBe(true);
      await until(async () => (await s.builds.get(id)).state === 'paused');
      expect(await states(s, id)).toEqual([
        ['applied', null],
        ['applied', null],
        ['queued', null],
      ]);
      await s.builds.resume(id);
      await s.builds.idle(id);
      expect((await s.builds.get(id)).tasks.every((task) => task.state === 'applied')).toBe(true);
    } finally {
      await close(s);
    }
  });

  it('cancel stops every running card\'s tree at once', async () => {
    const slow = plan([cardOf('One', 'WAIT 60000\nWRITE A.md: 1', ['a/']), cardOf('Two', 'WAIT 60000\nWRITE B.md: 2', ['b/']), cardOf('Three', 'WRITE C.md: 3', ['c/'])]);
    const s = setup(slow);
    try {
      const id = await startBuild(s, slow);
      await until(async () => (await s.builds.get(id)).tasks.slice(0, 2).every((task) => task.taskId !== undefined));
      const ids = (await s.builds.get(id)).tasks.slice(0, 2).map((task) => task.taskId as string);
      expect(ids.every((taskId) => s.builds.drives(taskId))).toBe(true);
      const at = Date.now();
      await s.builds.cancel(id);
      await until(async () => (await s.builds.get(id)).state === 'cancelled');
      expect(Date.now() - at).toBeLessThan(10_000);
      expect((await s.builds.get(id)).tasks.map((task) => task.state)).toEqual(['cancelled', 'cancelled', 'queued']);
      for (const taskId of ids) expect((await s.tasks.get(taskId)).state).toBe('cancelled');
      expect(s.tasks.activeIds()).toEqual([]);
      expect(ids.some((taskId) => s.builds.drives(taskId))).toBe(false);
    } finally {
      await close(s);
    }
  });

  it('a restart leaves the build interrupted with every running card waiting; Resume starts them again at the integration head', async () => {
    const slow = plan([cardOf('One', 'WAIT 60000\nWRITE A.md: 1', ['a/']), cardOf('Two', 'WAIT 60000\nWRITE B.md: 2', ['b/'])]);
    const s = setup(slow);
    const id = await startBuild(s, slow);
    await until(async () => (await s.builds.get(id)).tasks.every((task) => task.taskId !== undefined));
    const first = (await s.builds.get(id)).tasks.map((task) => task.taskId as string);
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    s.stopWatching();
    const quick = plan([cardOf('One', 'WRITE A.md: 1', ['a/']), cardOf('Two', 'WRITE B.md: 2', ['b/'])]);
    const after = setup(quick);
    try {
      await after.tasks.recover();
      expect(await after.builds.recover()).toBe(1);
      const view = await after.builds.get(id);
      expect(view.state).toBe('interrupted');
      expect(view.tasks.map((task) => [task.state, task.reason])).toEqual([
        ['waiting', 'interrupted'],
        ['waiting', 'interrupted'],
      ]);
      // The rounds' text is what was approved (WAIT 60000): the resumed rounds are stopped by the test once started.
      await after.builds.resume(id);
      await until(async () => (await after.builds.get(id)).tasks.every((task) => task.taskId !== undefined && !first.includes(task.taskId)));
      // The interrupted tasks are discarded: their worktrees are gone.
      for (const taskId of first) {
        expect((await after.tasks.get(taskId)).state).toBe('discarded');
        await expect(access(world.store.worktreeDir(taskId))).rejects.toBeDefined();
      }
      await after.builds.cancel(id);
      await until(async () => (await after.builds.get(id)).state === 'cancelled');
    } finally {
      await close(after);
    }
  });
});

describe('resuming after a restart, a card the user took up (review of M3, I3)', SLOW, () => {
  it('stays the user\'s: only cards whose task the stop left interrupted start again', async () => {
    const slow = plan([cardOf('One', 'WAIT 60000\nWRITE A.md: 1', ['a/']), cardOf('Two', 'WAIT 60000\nWRITE B.md: 2', ['b/'])]);
    const s = setup(slow);
    const id = await startBuild(s, slow);
    await until(async () => (await s.builds.get(id)).tasks.every((task) => task.taskId !== undefined));
    const [one, two] = (await s.builds.get(id)).tasks.map((task) => task.taskId as string);
    s.builds.stop();
    await s.tasks.shutdown();
    await s.builds.shutdown();
    s.stopWatching();
    const after = setup(slow);
    try {
      await after.tasks.recover();
      await after.builds.recover();
      // The user opens card One's task and runs a round of their own on it.
      await after.tasks.newRound(one as string, 'My own round.');
      await after.builds.resume(id);
      await until(async () => (await after.builds.get(id)).tasks[1]?.taskId !== two && (await after.builds.get(id)).tasks[1]?.taskId !== undefined);
      const view = await after.builds.get(id);
      expect(view.tasks[0]).toMatchObject({ state: 'waiting', reason: 'interrupted', taskId: one });
      expect((await after.tasks.get(one as string)).state).toBe('running');
      expect((await after.tasks.get(two as string)).state).toBe('discarded');
      after.tasks.cancel(one as string);
      await after.builds.cancel(id);
      await until(async () => (await after.builds.get(id)).state === 'cancelled');
    } finally {
      await close(after);
    }
  });
});

describe('the join and the one redo', SLOW, () => {
  it('a card that collides when joined is redone once on top of what was joined, then joined', async () => {
    const board = plan([cardOf('One', 'WRITE A.md: one', ['one/']), cardOf('Two', 'WAIT 1500\nWRITE A.md: two\nREDO-WRITE A.md: one and two', ['two/'])]);
    const s = setup(board);
    try {
      const id = await startBuild(s, board);
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
        ['applied', null],
        ['applied', null],
      ]);
      expect(done.tasks[1]?.redo).toMatchObject({ reason: 'conflict' });
      expect(done.tasks[1]?.rounds).toBe(2);
      expect(s.runner.started.filter((round) => round.prompt.includes('changed the same lines'))).toHaveLength(1);
      // The first attempt's task was discarded; the second started at the head with One's change.
      expect((await s.tasks.get(done.tasks[1]?.redo?.previousTask as string)).state).toBe('discarded');
      const head = (await integrationHead(project, done.branch)) as string;
      expect((await gitIn(project, 'show', `${head}:A.md`)).trim()).toBe('one and two');
      // The whole build applies: the discarded first attempt left nothing on the branch.
      expect((await s.builds.apply(id, (await s.builds.diff(id)).head as string)).state).toBe('applied');
    } finally {
      await close(s);
    }
  });

  it('a second conflict leaves the card waiting for the user, its task open', async () => {
    // Two and Three both collide with One; Three's redo usually joins first, so Two's slower redo collides
    // again. On a slow runner the order can turn (Windows CI, step 39: Three's first attempt ended after
    // Two's redo had joined): which of the two waits is the machine's timing, not the rule under test.
    const board = plan([
      cardOf('One', 'WRITE A.md: one', ['one/']),
      // Margins of 1.5 s and more: a loaded machine (a full test run) delays starts by hundreds of milliseconds.
      cardOf('Two', 'WAIT 1000\nWRITE A.md: two\nREDO-WAIT 5000\nREDO-WRITE A.md: two again', ['two/']),
      cardOf('Three', 'WAIT 2500\nWRITE A.md: three\nREDO-WRITE A.md: three again', ['three/']),
    ]);
    const s = setup(board);
    try {
      const id = await startBuild(s, board, { slots: 3 });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      const states = done.tasks.map((task) => [task.state, task.reason ?? null]);
      const detail = JSON.stringify(done.tasks.map((task) => ({ n: task.n, detail: task.detail, redo: task.redo, join: task.join })));
      expect(states[0], detail).toEqual(['applied', null]);
      // Exactly one of Two and Three collided a second time and waits; the other was joined.
      expect(
        [
          [['waiting', 'conflict'], ['applied', null]],
          [['applied', null], ['waiting', 'conflict']],
        ],
        detail,
      ).toContainEqual(states.slice(1));
      const waiting = done.tasks.find((task) => task.state === 'waiting');
      // It was redone once already, and its last join collided in the shared file.
      expect(waiting?.redo, detail).toMatchObject({ reason: 'conflict' });
      expect(waiting?.join, detail).toMatchObject({ outcome: 'conflict', files: ['A.md'] });
      expect((await s.tasks.get(waiting?.taskId as string)).state).toBe('proposal');
      expect(done.state).toBe('finished');
    } finally {
      await close(s);
    }
  });

  it('checks that fail only on the joined tree redo the card; a redo whose own checks then fail waits (review of M3: not joinChecksFailed)', async () => {
    // Checks fail when A.md and B.md say "clash" together; each card's own tree passes.
    const files = fileChecks((found) => found['A.md'] === 'clash' && found['B.md'] === 'clash');
    const board = plan([cardOf('One', 'WRITE A.md: clash', ['a/']), cardOf('Two', 'WAIT 1500\nWRITE B.md: clash\nREDO-WRITE B.md: fine', ['b/'])]);
    const s = setup(board, { checks: files.checks });
    try {
      const id = await startBuild(s, board, { checks: ['npm test'], noChecks: false });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => task.state)).toEqual(['applied', 'applied']);
      expect(done.tasks[1]?.redo).toMatchObject({ reason: 'checksFailed' });
    } finally {
      await close(s);
    }
    await world.cleanup();
    world = await taskWorld('builds-scheduler');
    project = await world.project('garden', { 'docs/BRIEF.md': '# Garden\n\n- Cards.\n' });
    const stubborn = plan([cardOf('One', 'WRITE A.md: clash', ['a/']), cardOf('Two', 'WAIT 1500\nWRITE B.md: clash', ['b/'])]);
    const t = setup(stubborn, { checks: files.checks });
    try {
      const id = await startBuild(t, stubborn, { checks: ['npm test'], noChecks: false });
      await t.builds.idle(id);
      // The redo starts at the head with One's change, so its own checks already see both files and fail: it waits there.
      expect(await states(t, id)).toEqual([
        ['applied', null],
        ['waiting', 'checksFailed'],
      ]);
      const two = (await t.builds.get(id)).tasks[1];
      expect(two?.redo).toMatchObject({ reason: 'checksFailed' });
      expect(two?.join).toMatchObject({ outcome: 'checksFailed', checks: [{ exitCode: 1 }] });
    } finally {
      await close(t);
    }
  });
});

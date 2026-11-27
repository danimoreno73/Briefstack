import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import type { PlanOutput, QueueItem } from '../../src/builds/types.js';
import type { UsageReading } from '../../src/builds/usage.js';
import type { ReserveProvider } from '../../src/providers/config.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import type { CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// Phase 12, M4: a build at the usage threshold goes on with a reserve
// provider (PLAN-phase-12 §1, 11 and 12), over the fake planner and the fake
// task runner on a temp git repository.

useHermeticGit();

let world: TaskWorld;
let keyFile: string;
// Built at run time: no file in the repo holds a secret-looking value.
const KEY = ['reserve', 'key', 'q'.repeat(24)].join('-');

/** Each card writes the file its instruction names (`WRITE <file> [text]`), after `WAIT <ms>` when it says so. */
const script: TaskFakeScript = (_round, prompt) => {
  const write = /^WRITE (\S+)(?: (.+))?$/m.exec(prompt);
  const file = write?.[1] ?? 'OUT.md';
  const wait = Number(/^WAIT (\d+)$/m.exec(prompt)?.[1] ?? '0');
  return { steps: [...(wait > 0 ? [{ kind: 'wait' as const, ms: wait }] : []), { kind: 'write', file, content: `${write?.[2] ?? file}\n` }, { kind: 'end', summary: 'Done.' }] };
};
const card = (title: string, file: string): QueueItem => ({ title, instruction: `WRITE ${file}`, doneWhen: 'Done.', dependsOn: [], area: [file] });
const PLAN: PlanOutput = { tasks: [card('One', 'A.md'), card('Two', 'B.md'), card('Three', 'C.md')], commands: ['npm test'], checks: [] };

const LOW: UsageReading = { kind: 'ok', fiveHour: 10, sevenDay: 10 };
const OVER: UsageReading = { kind: 'ok', fiveHour: 95, sevenDay: 10 };

interface Setup {
  builds: BuildManager;
  tasks: TaskManager;
  runner: TaskFakeRunner;
}

function setup(usage: UsageReading[], options: { providers?: ReserveProvider[] | (() => Promise<ReserveProvider[]>); checks?: TaskChecks } = {}): Setup {
  const holder: { builds?: BuildManager } = {};
  const runner = new TaskFakeRunner({ script });
  const tasks = new TaskManager({
    runner,
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 4,
    pollMs: 10,
    afterRound: afterRoundWith(),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    buildOn: (slug) => holder.builds?.holder(slug),
    buildDrives: (id) => holder.builds?.drives(id) ?? false,
  });
  const readings = [...usage];
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner: new FakeBuildPlanner(PLAN),
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => 4,
    usage: async () => readings.shift() ?? LOW,
    usageRetryMs: 60_000,
    slotRetryMs: 20,
    providers:
      typeof options.providers === 'function'
        ? options.providers
        : async () => (options.providers as ReserveProvider[] | undefined) ?? [{ name: 'deepseek', baseUrl: 'https://api.deepseek.invalid/anthropic', model: 'big-model', keyFile }],
  });
  holder.builds = builds;
  return { builds, tasks, runner };
}

async function close(s: Setup): Promise<void> {
  await s.builds.shutdown();
  await s.tasks.shutdown();
}

const startOf = (overrides: Partial<BuildStartInput> = {}): BuildStartInput => ({
  tasks: PLAN.tasks,
  limit: PLAN.tasks.length,
  commands: ['npm test'],
  checks: [],
  noChecks: true,
  fixRounds: 0,
  thresholds: { fiveHour: 80, week: 90 },
  slots: 1,
  reserve: 'deepseek',
  ...overrides,
});

async function startBuild(s: Setup, overrides: Partial<BuildStartInput> = {}): Promise<string> {
  const build = await s.builds.plan('garden');
  await s.builds.idle(build.id);
  await s.builds.start(build.id, startOf(overrides));
  return build.id;
}

beforeEach(async () => {
  world = await taskWorld('builds-reserve');
  await world.project('garden', { 'docs/BRIEF.md': '# Garden\n\n- Cards.\n' });
  // Outside the home, which may not exist yet: where the user keeps the key.
  keyFile = path.join(world.dir, 'deepseek.key');
  await writeFile(keyFile, `${KEY}\n`, 'utf8');
});
afterEach(() => world.cleanup());

const SLOW = { timeout: 90_000 };

describe('a build with a reserve provider', SLOW, () => {
  it('goes on with it while the plan is over its threshold, and back on Claude below it', async () => {
    const s = setup([LOW, OVER, LOW]);
    try {
      const id = await startBuild(s);
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.state, task.provider ?? null])).toEqual([
        ['applied', null],
        ['applied', 'deepseek'],
        ['applied', null],
      ]);
      expect(s.runner.started.map((round) => round.provider?.name ?? null)).toEqual([null, 'deepseek', null]);
      // The round records the provider it ran on; its tokens are that provider's.
      const second = await s.tasks.get(done.tasks[1]?.taskId as string);
      expect(second.rounds[0]?.provider).toBe('deepseek');
      expect((await s.tasks.get(done.tasks[0]?.taskId as string)).rounds[0]?.provider).toBeUndefined();
      // The key is in no record.
      expect(JSON.stringify(done)).not.toContain(KEY);
      expect(JSON.stringify(second)).not.toContain(KEY);
    } finally {
      await close(s);
    }
  });

  it('keeps the provider a card started on for its fix rounds', async () => {
    let runs = 0;
    const checks: TaskChecks = {
      commands: async () => [],
      run: async (_dir, commands): Promise<CheckResult[]> => {
        runs += 1;
        return commands.map((command) => ({ command, exitCode: runs === 1 ? 1 : 0, timedOut: false, output: runs === 1 ? 'FAIL' : 'ok', durationMs: 1 }));
      },
    };
    const s = setup([OVER, LOW], { checks });
    try {
      const id = await startBuild(s, { tasks: [card('One', 'A.md')], limit: 1, checks: ['npm test'], noChecks: false, fixRounds: 1 });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks[0]).toMatchObject({ state: 'applied', provider: 'deepseek', rounds: 2 });
      expect(s.runner.started.map((round) => round.provider?.name ?? null)).toEqual(['deepseek', 'deepseek']);
    } finally {
      await close(s);
    }
  });

  it('pauses as before when its key file is missing at the threshold, and says why', async () => {
    await rm(keyFile);
    const s = setup([OVER]);
    try {
      const id = await startBuild(s);
      await s.builds.idle(id);
      const paused = await s.builds.get(id);
      expect(paused.state).toBe('paused');
      expect(paused.pause).toMatchObject({ reason: 'usage', reserveMissing: 'deepseek' });
      expect(s.runner.started).toHaveLength(0);
    } finally {
      await close(s);
    }
  });

  it('keeps the provider for a card\'s redo after a conflicted join (review of M4, I2)', async () => {
    // Two cards of separate declared areas both write SAME.md, differently: the second joined conflicts and is redone.
    const both = [
      { title: 'One', instruction: 'WRITE SAME.md one', doneWhen: 'Done.', dependsOn: [], area: ['a/'] },
      { title: 'Two', instruction: 'WRITE SAME.md two', doneWhen: 'Done.', dependsOn: [], area: ['b/'] },
    ];
    const s = setup([OVER]);
    try {
      const id = await startBuild(s, { tasks: both, limit: 2, slots: 2 });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      const redone = done.tasks.filter((task) => task.redo?.reason === 'conflict');
      expect(redone).toHaveLength(1);
      expect(done.tasks.map((task) => task.provider)).toEqual(['deepseek', 'deepseek']);
      expect(s.runner.started).toHaveLength(3);
      expect(s.runner.started.map((round) => round.provider?.name)).toEqual(['deepseek', 'deepseek', 'deepseek']);
    } finally {
      await close(s);
    }
  });

  it('a card at work on Claude goes on there when the threshold is crossed; the next one starts on the reserve (review of M4, I3)', async () => {
    const three = [
      { title: 'Long', instruction: 'WAIT 800\nWRITE A.md', doneWhen: 'Done.', dependsOn: [], area: ['A.md'] },
      { title: 'Short', instruction: 'WRITE B.md', doneWhen: 'Done.', dependsOn: [], area: ['B.md'] },
      { title: 'Next', instruction: 'WRITE C.md', doneWhen: 'Done.', dependsOn: [], area: ['C.md'] },
    ];
    const s = setup([LOW, OVER]);
    try {
      const id = await startBuild(s, { tasks: three, limit: 3, slots: 2 });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => [task.title, task.state, task.provider ?? null])).toEqual([
        ['Long', 'applied', null],
        ['Short', 'applied', null],
        ['Next', 'applied', 'deepseek'],
      ]);
    } finally {
      await close(s);
    }
  });

  it('pauses when the key file holds no key on one line, and the user\'s Resume goes on with Claude', async () => {
    await writeFile(keyFile, `${KEY}\n${KEY}\n`, 'utf8');
    const s = setup([OVER]);
    try {
      const id = await startBuild(s);
      await s.builds.idle(id);
      expect((await s.builds.get(id)).pause).toMatchObject({ reason: 'usage', reserveMissing: 'deepseek' });
      await s.builds.resume(id);
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.every((task) => task.state === 'applied' && task.provider === undefined)).toBe(true);
      expect(s.runner.started.map((round) => round.provider?.name ?? null)).toEqual([null, null, null]);
    } finally {
      await close(s);
    }
  });

  it('pauses when the reserve is no longer in config.json', async () => {
    // There at the start (the start's own check reads the list first), gone from config.json at the threshold.
    let calls = 0;
    const listed: ReserveProvider[] = [{ name: 'deepseek', baseUrl: 'https://api.deepseek.invalid/anthropic', model: 'big-model', keyFile }];
    const s = setup([OVER], { providers: async () => (calls++ === 0 ? listed : []) });
    try {
      const id = await startBuild(s);
      await s.builds.idle(id);
      expect((await s.builds.get(id)).pause).toMatchObject({ reason: 'usage', reserveMissing: 'deepseek' });
    } finally {
      await close(s);
    }
  });

  it('still pauses when the usage cannot be read: unknown is not "over"', async () => {
    const s = setup([{ kind: 'failed', message: 'no answer' }]);
    try {
      const id = await startBuild(s);
      await s.builds.idle(id);
      const paused = await s.builds.get(id);
      expect(paused.pause).toMatchObject({ reason: 'usageUnread' });
      expect(paused.pause?.reserveMissing).toBeUndefined();
      expect(s.runner.started).toHaveLength(0);
    } finally {
      await close(s);
    }
  });

  it('without a reserve pauses at the threshold, as before', async () => {
    const s = setup([OVER]);
    try {
      const build = await s.builds.plan('garden');
      await s.builds.idle(build.id);
      const noReserve = startOf();
      delete noReserve.reserve;
      await s.builds.start(build.id, noReserve);
      await s.builds.idle(build.id);
      expect((await s.builds.get(build.id)).pause).toMatchObject({ reason: 'usage' });
      expect(s.runner.started).toHaveLength(0);
    } finally {
      await close(s);
    }
  });

  it('refuses a start with a reserve config.json does not have', async () => {
    const s = setup([], { providers: [] });
    try {
      const build = await s.builds.plan('garden');
      await s.builds.idle(build.id);
      await expect(s.builds.start(build.id, startOf())).rejects.toMatchObject({ code: 'build.reserveUnknown', params: { name: 'deepseek' } });
      expect((await s.builds.get(build.id)).state).toBe('planned');
    } finally {
      await close(s);
    }
  });
});

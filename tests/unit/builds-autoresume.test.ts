import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BUILD_SLOTS, buildsSettingsOf, parseConfig } from '../../src/config/index.js';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import { MAX_AUTO_RESUMES, MAX_SLOTS, type BuildRecord, type PlanOutput, type QueueItem } from '../../src/builds/types.js';
import type { UsageReading } from '../../src/builds/usage.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { useHermeticGit } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// Phase 12, M5: builds resume by themselves after a restart, and the
// machine's cap on slots (PLAN-phase-12 §1, 13 and 14; H0, 5), over the fake
// planner and task runner on a temp git repository. A restart is simulated
// as in builds-scheduler.test.ts: the managers stop as an abrupt stop leaves
// things, and new ones open the same home and recover.

useHermeticGit();

let world: TaskWorld;
/** Rounds wait their `WAIT` only while this is on: the rounds after a restart run at once. */
let slow = true;

const script: TaskFakeScript = (_round, prompt) => {
  const file = /^WRITE (\S+)$/m.exec(prompt)?.[1] ?? 'OUT.md';
  const wait = Number(/^WAIT (\d+)$/m.exec(prompt)?.[1] ?? '0');
  return { steps: [...(slow && wait > 0 ? [{ kind: 'wait' as const, ms: wait }] : []), { kind: 'write', file, content: `${file}\n` }, { kind: 'end', summary: 'Done.' }] };
};
const card = (title: string, instruction: string, area: string): QueueItem => ({ title, instruction, doneWhen: 'Done.', dependsOn: [], area: [area] });
const PLAN: PlanOutput = { tasks: [card('One', 'WAIT 60000\nWRITE A.md', 'A.md'), card('Two', 'WRITE B.md', 'B.md')], commands: ['npm test'], checks: [] };
const LOW: UsageReading = { kind: 'ok', fiveHour: 10, sevenDay: 10 };

interface Setup {
  builds: BuildManager;
  tasks: TaskManager;
  runner: TaskFakeRunner;
  reads: () => number;
  peak: () => number;
  close: () => Promise<void>;
}

function setup(options: { usage?: UsageReading[]; slotsCap?: number } = {}): Setup {
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
    buildOn: (slug) => holder.builds?.holder(slug),
    buildDrives: (id) => holder.builds?.drives(id) ?? false,
  });
  const readings = [...(options.usage ?? [])];
  let reads = 0;
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner: new FakeBuildPlanner(PLAN),
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => 4,
    usage: async () => {
      reads += 1;
      return readings.shift() ?? LOW;
    },
    usageRetryMs: 60_000,
    slotRetryMs: 20,
    ...(options.slotsCap === undefined ? {} : { slotsCap: async () => options.slotsCap as number }),
  });
  holder.builds = builds;
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, tasks.activeIds().length)), 5);
  return {
    builds,
    tasks,
    runner,
    reads: () => reads,
    peak: () => peak,
    close: async () => {
      clearInterval(timer);
      builds.stop();
      await tasks.shutdown();
      await builds.shutdown();
    },
  };
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
  ...overrides,
});

async function until(check: () => boolean | Promise<boolean>, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Starts a build and waits until its first card is at work, then stops everything as a crash would leave it. */
async function startAndCrash(overrides: Partial<BuildStartInput> = {}): Promise<string> {
  const s = setup();
  const build = await s.builds.plan('garden');
  await s.builds.idle(build.id);
  await s.builds.start(build.id, startOf(overrides));
  await until(async () => (await s.builds.get(build.id)).tasks[0]?.taskId !== undefined);
  await s.close();
  return build.id;
}

/** A new server on the same home: both recoveries, as `briefstack web` does. */
async function restart(options: { usage?: UsageReading[]; slotsCap?: number } = {}): Promise<Setup> {
  const s = setup(options);
  await s.tasks.recover();
  await s.builds.recover();
  return s;
}

const store = () => new BuildStore(buildsRoot(world.home));
async function change(id: string, edit: (record: BuildRecord) => BuildRecord): Promise<void> {
  const record = (await store().load(id)) as BuildRecord;
  await store().save(edit(record));
}

beforeEach(async () => {
  slow = true;
  world = await taskWorld('builds-autoresume');
  await world.project('garden', { 'docs/BRIEF.md': '# Garden\n\n- Cards.\n' });
});
afterEach(() => world.cleanup());

const SLOW = { timeout: 90_000 };

describe('the settings', () => {
  it('are off and 4 by default, and read strictly', () => {
    expect(buildsSettingsOf({})).toEqual({ autoResume: false, slotsCap: 4 });
    expect(buildsSettingsOf(parseConfig(JSON.stringify({ buildsAutoResume: true, buildSlotsCap: 2 }), 'c'))).toEqual({ autoResume: true, slotsCap: 2 });
    for (const bad of [{ buildsAutoResume: 'yes' }, { buildSlotsCap: 0 }, { buildSlotsCap: 5 }, { buildSlotsCap: 1.5 }]) {
      expect(() => parseConfig(JSON.stringify(bad), 'c'), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'config.invalidField' }));
    }
    expect(MAX_BUILD_SLOTS).toBe(MAX_SLOTS);
  });
});

describe('auto-resume after a restart', SLOW, () => {
  it('a build that was running resumes by itself: the usage read first, its interrupted card started again with one slot', async () => {
    const id = await startAndCrash();
    slow = false;
    const s = await restart();
    try {
      const before = await s.builds.get(id);
      expect(before).toMatchObject({ state: 'interrupted', restart: { from: 'running' } });
      const interrupted = before.tasks[0]?.taskId as string;
      expect(await s.builds.autoResume()).toEqual([id]);
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.state, task.reason ?? null, task.detail ?? null])).toEqual([
        ['applied', null, null],
        ['applied', null, null],
      ]);
      expect(done.tasks[0]?.taskId).not.toBe(interrupted);
      expect((await s.tasks.get(interrupted)).state).toBe('discarded');
      // Read before the next cards, unlike the user's Resume.
      expect(s.reads()).toBeGreaterThanOrEqual(1);
      // A card ended: the run of restarts in a row is over; the restart mark is gone.
      expect(done.autoResumes).toBeUndefined();
      expect(done.restart).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('without the call (the setting off), it stays interrupted as before', async () => {
    const id = await startAndCrash();
    const s = await restart();
    try {
      expect((await s.builds.get(id)).state).toBe('interrupted');
      expect(s.runner.started).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('a build paused for usage goes back to paused with its timer, then resumes by itself at its time', async () => {
    const id = await startAndCrash();
    slow = false;
    // As if it had been paused for usage when the server stopped: its cards drained, its reset still ahead.
    await change(id, (record) => ({ ...record, state: 'paused', tasks: record.tasks.map((task) => ({ ...task, state: 'queued' as const })), pause: { reason: 'usage', at: new Date().toISOString(), until: new Date(Date.now() + 400).toISOString(), fiveHour: 95 } }));
    const s = await restart();
    try {
      expect(await s.builds.autoResume()).toEqual([id]);
      expect((await s.builds.get(id)).state).toBe('paused');
      expect((await s.builds.get(id)).pause).toMatchObject({ reason: 'usage', fiveHour: 95 });
      await until(async () => (await s.builds.get(id)).state === 'finished');
    } finally {
      await s.close();
    }
  });

  it('a build paused for usage whose time passed resumes at once, reading the usage', async () => {
    const id = await startAndCrash();
    slow = false;
    await change(id, (record) => ({ ...record, state: 'paused', tasks: record.tasks.map((task) => ({ ...task, state: 'queued' as const })), pause: { reason: 'usage', at: new Date().toISOString(), until: new Date(Date.now() - 1000).toISOString() } }));
    const s = await restart();
    try {
      await s.builds.autoResume();
      await s.builds.idle(id);
      expect((await s.builds.get(id)).state).toBe('finished');
      expect(s.reads()).toBeGreaterThanOrEqual(1);
    } finally {
      await s.close();
    }
  });

  it('a build the user had paused stays interrupted', async () => {
    const id = await startAndCrash();
    await change(id, (record) => ({ ...record, state: 'paused', tasks: record.tasks.map((task) => ({ ...task, state: 'queued' as const })), pause: { reason: 'user', at: new Date().toISOString() } }));
    const s = await restart();
    try {
      expect(await s.builds.autoResume()).toEqual([]);
      expect((await s.builds.get(id)).state).toBe('interrupted');
    } finally {
      await s.close();
    }
  });

  it(`stops resuming by itself after ${MAX_AUTO_RESUMES} restarts in a row without a card ending, says so, and the user's Resume clears it`, async () => {
    const id = await startAndCrash();
    slow = false;
    const s = await restart();
    try {
      await change(id, (record) => ({ ...record, autoResumes: MAX_AUTO_RESUMES }));
      expect(await s.builds.autoResume()).toEqual([]);
      const stopped = await s.builds.get(id);
      expect(stopped).toMatchObject({ state: 'interrupted', autoResumeStopped: true });
      expect(s.runner.started).toHaveLength(0);
      await s.builds.resume(id);
      await until(async () => (await s.builds.get(id)).state === 'finished' || (await s.builds.get(id)).state === 'paused');
      const after = await s.builds.get(id);
      expect(after.autoResumeStopped).toBeUndefined();
      expect(after.autoResumes).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('counts each restart in a row', async () => {
    const id = await startAndCrash();
    // Twice: resumed by itself, and the card at work again when the server stops.
    for (let i = 1; i <= 2; i += 1) {
      const s = await restart();
      await s.builds.autoResume();
      await until(async () => (await s.builds.get(id)).tasks[0]?.state === 'running' && (await s.builds.get(id)).tasks[0]?.taskId !== undefined);
      expect((await s.builds.get(id)).autoResumes).toBe(i);
      await s.close();
    }
  });
});

describe('the cap on slots', SLOW, () => {
  it('a build started with three slots runs one card at a time on a machine capped at one', async () => {
    slow = false;
    const three: PlanOutput = { tasks: [card('A', 'WAIT 300\nWRITE A.md', 'A.md'), card('B', 'WAIT 300\nWRITE B.md', 'B.md'), card('C', 'WAIT 300\nWRITE C.md', 'C.md')], commands: ['npm test'], checks: [] };
    slow = true;
    const s = setup({ slotsCap: 1 });
    try {
      const build = await s.builds.plan('garden');
      await s.builds.idle(build.id);
      await s.builds.start(build.id, startOf({ tasks: three.tasks, limit: 3, slots: 3 }));
      await s.builds.idle(build.id);
      const done = await s.builds.get(build.id);
      expect(done.tasks.map((task) => task.state)).toEqual(['applied', 'applied', 'applied']);
      expect(done.settings?.slots).toBe(3);
      expect(s.peak()).toBe(1);
      expect(await s.builds.slotsCapNow()).toBe(1);
    } finally {
      await s.close();
    }
  });
});

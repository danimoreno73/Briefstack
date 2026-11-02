import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager, type TaskView } from '../../src/tasks/manager.js';
import type { TaskRecord } from '../../src/tasks/types.js';
import { useHermeticGit } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// Once a server stop begins, nothing new starts on a task (R1 of the review
// of step 06): no checks, no round, no task. The stop ends only what it
// finds, so work that started after it began would outlive the server.

useHermeticGit();

/** Where a request waits before it changes a task's record; `before` lets a test hold it there. */
type WaitPoint = 'limit' | 'commands' | 'inspectProject' | 'projectRestrictions';
const hooks = vi.hoisted(() => ({ before: undefined as undefined | ((point: WaitPoint) => Promise<void>) }));

vi.mock('../../src/tasks/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/tasks/session.js')>();
  return {
    ...original,
    inspectProject: async (...args: Parameters<typeof original.inspectProject>) => {
      await hooks.before?.('inspectProject');
      return original.inspectProject(...args);
    },
    projectRestrictions: async (...args: Parameters<typeof original.projectRestrictions>) => {
      await hooks.before?.('projectRestrictions');
      return original.projectRestrictions(...args);
    },
  };
});

let world: TaskWorld;

beforeEach(async () => {
  world = await taskWorld('tasks-stopping');
});
afterEach(async () => {
  hooks.before = undefined;
  await world.cleanup();
});

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** A promise the test settles. */
const gate = () => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

interface Setup {
  m: TaskManager;
  runner: TaskFakeRunner;
  /** The commands the checks were asked to run: a process each. */
  calls: string[][];
}

function setup(): Setup {
  const runner = new TaskFakeRunner();
  const calls: string[][] = [];
  const checks: TaskChecks = {
    commands: async () => {
      await hooks.before?.('commands');
      return ['npm test'];
    },
    run: async (_dir, commands) => (calls.push([...commands]), []),
  };
  const m = new TaskManager({
    runner,
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: async () => {
      await hooks.before?.('limit');
      return 2;
    },
    pollMs: 10,
    checks,
  });
  return { m, runner, calls };
}

/** Two projects, and a task on the first one waiting on its proposal. */
async function proposal(m: TaskManager): Promise<TaskView> {
  await world.project('garden');
  await world.project('orchard');
  await world.initLibrary();
  const task = await m.start('garden', 'Add a changelog.');
  await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
  m.finishRound(task.id);
  await until(async () => (await m.get(task.id)).state === 'proposal', 'the proposal');
  return m.get(task.id);
}

/** Holds the first save `matches` picks until the test opens `release`; `reached` opens when it is held. */
function holdSave(matches: (record: TaskRecord) => boolean): { reached: Promise<void>; release: () => void } {
  const reached = gate();
  const release = gate();
  const save = world.store.save.bind(world.store);
  let held = false;
  world.store.save = async (record: TaskRecord) => {
    if (!held && matches(record)) {
      held = true;
      reached.open();
      await release.promise;
    }
    return save(record);
  };
  return { reached: reached.promise, release: release.open };
}

const stopping = { status: 'rejected', reason: { code: 'task.stopping' } };

describe('a server stop refuses new work on tasks (R1)', { timeout: 60_000 }, () => {
  it('refuses the checks asked once the stop began, and runs nothing', async () => {
    const { m, calls } = setup();
    const task = await proposal(m);
    const stop = m.shutdown();
    const [checked] = await Promise.allSettled([m.runChecks(task.id, ['npm test'])]);
    await stop;
    expect(checked).toMatchObject(stopping);
    expect(calls).toEqual([]);
    expect((await world.store.load(task.id))?.state).toBe('proposal');
  });

  it('refuses checks whose request was saving the task when the stop began, and starts no process', async () => {
    const { m, calls } = setup();
    const task = await proposal(m);
    // The request is past every check of its own and waits for the record to be saved, before the checks get their controller.
    const held = holdSave((record) => record.id === task.id && record.state === 'checking' && record.reviewed !== undefined && record.checks === undefined);
    const check = m.runChecks(task.id, ['npm test']);
    await held.reached;
    const stop = m.shutdown();
    held.release();
    const [checked] = await Promise.allSettled([check]);
    await stop;
    expect(checked).toMatchObject(stopping);
    expect(calls).toEqual([]);
    // Left as an abrupt stop leaves it: the next start puts it back on its proposal, without running anything.
    expect((await world.store.load(task.id))?.state).toBe('checking');
    const fresh = setup();
    expect(await fresh.m.recover()).toBe(1);
    expect(await fresh.m.get(task.id)).toMatchObject({ state: 'proposal', reviewed: task.reviewed });
    expect(fresh.calls).toEqual([]);
  });

  it('refuses a new round and a new task once the stop began, and starts no session', async () => {
    const { m, runner } = setup();
    const task = await proposal(m);
    const sessions = runner.started.length;
    const stop = m.shutdown();
    const [again, other] = await Promise.allSettled([m.newRound(task.id, 'More.'), m.start('orchard', 'Add a readme.')]);
    await stop;
    expect(again).toMatchObject(stopping);
    expect(other).toMatchObject(stopping);
    expect(runner.started.length).toBe(sessions);
    expect((await world.store.list()).map((record) => record.id)).toEqual([task.id]);
    expect((await world.store.load(task.id))?.state).toBe('proposal');
  });

  it('starts no session for a new round that was saving the task when the stop began', async () => {
    const { m, runner } = setup();
    const task = await proposal(m);
    const sessions = runner.started.length;
    const held = holdSave((record) => record.id === task.id && record.state === 'running' && record.rounds.length === 2);
    const round = m.newRound(task.id, 'More.');
    await held.reached;
    const stop = m.shutdown();
    held.release();
    const [again] = await Promise.allSettled([round]);
    await stop;
    expect(again).toMatchObject(stopping);
    expect(runner.started.length).toBe(sessions);
    // Left as an abrupt stop leaves it: the next start marks the round interrupted.
    expect(await setup().m.recover()).toBe(1);
    const record = await world.store.load(task.id);
    expect(record?.state).toBe('interrupted');
    expect(record?.rounds.at(-1)).toMatchObject({ n: 2, outcome: 'interrupted' });
  });

  it('starts no session for a new task that was saving itself when the stop began, and leaves nothing of it', async () => {
    const { m, runner } = setup();
    const first = await proposal(m);
    const sessions = runner.started.length;
    const held = holdSave((record) => record.project === 'orchard' && record.state === 'running');
    const start = m.start('orchard', 'Add a readme.');
    await held.reached;
    const stop = m.shutdown();
    held.release();
    const [other] = await Promise.allSettled([start]);
    await stop;
    expect(other).toMatchObject(stopping);
    expect(runner.started.length).toBe(sessions);
    expect((await world.store.list()).map((record) => record.id)).toEqual([first.id]);
  });
});

/** Holds the request at `point` once, until `release()`; `reached` opens when it waits there. */
function holdAt(point: WaitPoint): { reached: Promise<void>; release: () => void } {
  const reached = gate();
  const release = gate();
  let held = false;
  hooks.before = async (at) => {
    if (held || at !== point) return;
    held = true;
    reached.open();
    await release.promise;
  };
  return { reached: reached.promise, release: release.open };
}

// The stop is read again just before a request changes the record (review of step 07, M2): a request that was waiting
// when the stop began is refused with nothing changed, so the reviewed proposal is kept, on disk and in memory.
describe('a stop that begins while a request waits changes nothing on the task', { timeout: 60_000 }, () => {
  async function stopWhileWaiting(point: WaitPoint, ask: (m: TaskManager, id: string) => Promise<unknown>): Promise<void> {
    const { m, runner, calls } = setup();
    const task = await proposal(m);
    const before = await world.store.load(task.id);
    expect(before).toMatchObject({ state: 'proposal', reviewed: task.reviewed, validations: [] });
    const sessions = runner.started.length;
    const held = holdAt(point);
    const request = ask(m, task.id);
    await held.reached;
    const stop = m.shutdown();
    held.release();
    const [result] = await Promise.allSettled([request]);
    await stop;
    expect(result).toMatchObject(stopping);
    expect(await world.store.load(task.id)).toEqual(before);
    expect(await m.get(task.id)).toMatchObject({ state: 'proposal', reviewed: task.reviewed, validations: [], rounds: before?.rounds });
    expect(m.activeIds()).toEqual([]);
    expect(runner.started.length).toBe(sessions);
    expect(calls).toEqual([]);
  }

  for (const point of ['limit', 'inspectProject', 'projectRestrictions'] as const) {
    it(`a new round waiting on ${point}`, () => stopWhileWaiting(point, (m, id) => m.newRound(id, 'More.')));
  }
  for (const point of ['commands', 'limit'] as const) {
    it(`checks waiting on ${point}`, () => stopWhileWaiting(point, (m, id) => m.runChecks(id, ['npm test'])));
  }
});

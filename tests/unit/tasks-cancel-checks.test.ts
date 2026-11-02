import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS } from '../../src/chat/toolNames.js';
import { setProjectChecks, taskChecksWith, type TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager, type TaskView } from '../../src/tasks/manager.js';
import { useHermeticGit } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// Cancelling the checks from the proposal page (IDEAS §7; review of step 05,
// M2): the running command's process tree is ended, as a server stop ends
// it, nothing they did is kept, and the task is back on its proposal
// without checks, as after a restart.

useHermeticGit();

let world: TaskWorld;

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** A check command that runs on Windows (`cmd`) and elsewhere (`sh`). */
const nodeCommand = (code: string) => `node -e "${code}"`;
/** Writes its pid where the clean-up keeps it (ignored), then runs for a minute. */
const LONG = nodeCommand("require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/pid.txt',String(process.pid));setTimeout(()=>{},60000)");
/** Leaves a file where the clean-up keeps it, so a test can tell it ran. */
const MARK = nodeCommand("require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ran.txt','x')");
/** Leaves an untracked file the clean-up removes. */
const LEAVE = nodeCommand("require('fs').writeFileSync('left.txt','x')");

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function manager(checks?: TaskChecks): TaskManager {
  return new TaskManager({
    runner: new TaskFakeRunner(),
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 2,
    pollMs: 10,
    checks: checks ?? taskChecksWith({ libraryDir: async () => world.library, home: world.home }),
  });
}

/** A project with these confirmed checks, and a task on it waiting on its proposal. */
async function proposal(m: TaskManager, commands: string[]): Promise<TaskView> {
  await world.project('garden');
  await world.initLibrary();
  await setProjectChecks({ libraryDir: world.library, home: world.home, slug: 'garden', commands });
  const task = await m.start('garden', 'Add a changelog.');
  await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
  m.finishRound(task.id);
  await until(async () => (await m.get(task.id)).state === 'proposal', 'the proposal');
  return m.get(task.id);
}

/** Runs the checks and waits for the long command's pid. */
async function startLong(m: TaskManager, task: TaskView, commands: string[]): Promise<number> {
  const pidFile = path.join(world.store.worktreeDir(task.id), 'node_modules', 'pid.txt');
  await m.runChecks(task.id, commands);
  await until(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '', 'the command to start');
  return Number(await readFile(pidFile, 'utf8'));
}

beforeEach(async () => {
  world = await taskWorld('tasks-cancel-checks');
});
afterEach(() => world.cleanup());

describe('cancelling the checks', { timeout: 60_000 }, () => {
  it('ends the running command\'s process tree, keeps nothing they did, and the task is back on its proposal without checks', async () => {
    const m = manager();
    const task = await proposal(m, [LEAVE, LONG, MARK]);
    const worktree = world.store.worktreeDir(task.id);
    const pid = await startLong(m, task, [LEAVE, LONG, MARK]);
    expect(alive(pid)).toBe(true);
    expect(await exists(path.join(worktree, 'left.txt'))).toBe(true);

    const before = Date.now();
    const back = await m.cancelChecks(task.id);
    // Not the command's minute: the cancel ended it.
    expect(Date.now() - before).toBeLessThan(20_000);
    await until(() => !alive(pid), 'the command to end');
    expect(back).toMatchObject({ state: 'proposal', reviewed: task.reviewed, validations: task.validations });
    expect(back.checks).toBeUndefined();
    // On disk too, with no partial results.
    const stored = await world.store.load(task.id);
    expect(stored).toMatchObject({ state: 'proposal', reviewed: task.reviewed });
    expect(stored?.checks).toBeUndefined();
    // The command after it never started, and what the first one left is gone.
    expect(await exists(path.join(worktree, 'node_modules', 'ran.txt'))).toBe(false);
    expect(await exists(path.join(worktree, 'left.txt'))).toBe(false);
    // The task can still be approved.
    expect((await m.approve(task.id)).state).toBe('applied');
    await m.shutdown();
  });

  it('refuses with a clear error when no checks are running, and on a task it does not know', async () => {
    const m = manager();
    const task = await proposal(m, [MARK]);
    await expect(m.cancelChecks(task.id)).rejects.toMatchObject({ code: 'task.checksNotRunning', params: { id: task.id } });
    // Checks that already ended: nothing to cancel, the results stay.
    await m.runChecks(task.id, [MARK]);
    await until(async () => (await m.get(task.id)).state === 'proposal', 'the checks');
    await expect(m.cancelChecks(task.id)).rejects.toMatchObject({ code: 'task.checksNotRunning' });
    expect((await m.get(task.id)).checks).toMatchObject([{ command: MARK, exitCode: 0 }]);
    await expect(m.cancelChecks('zzzzzz-0000')).rejects.toMatchObject({ code: 'task.notFound' });
    await m.shutdown();
  });

  it('cancels nothing but the checks: a running round is refused and goes on', async () => {
    const m = manager();
    await world.project('garden');
    const task = await m.start('garden', 'Add a changelog.');
    await expect(m.cancelChecks(task.id)).rejects.toMatchObject({ code: 'task.checksNotRunning' });
    expect((await m.get(task.id)).state).toBe('running');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    await m.shutdown();
  });

  it('lets the user run them again after a cancel, and keeps those results', async () => {
    const m = manager();
    const task = await proposal(m, [LONG]);
    const first = await startLong(m, task, [LONG]);
    await m.cancelChecks(task.id);
    await until(() => !alive(first), 'the command to end');

    await setProjectChecks({ libraryDir: world.library, home: world.home, slug: 'garden', commands: [MARK] });
    await m.runChecks(task.id, [MARK]);
    await until(async () => (await m.get(task.id)).state === 'proposal', 'the checks');
    expect((await m.get(task.id)).checks).toMatchObject([{ command: MARK, exitCode: 0, timedOut: false }]);
    expect((await world.store.load(task.id))?.checks).toHaveLength(1);
    await m.shutdown();
  });

  it('is refused once a server stop began, which ends the checks itself', async () => {
    const m = manager();
    const task = await proposal(m, [LONG]);
    const pid = await startLong(m, task, [LONG]);
    const stopped = m.shutdown();
    await expect(m.cancelChecks(task.id)).rejects.toMatchObject({ code: 'task.stopping' });
    await stopped;
    await until(() => !alive(pid), 'the command to end');
    // As the stop leaves it: the next start's recovery puts it back.
    expect((await world.store.load(task.id))?.state).toBe('checking');
  });
});

describe('the chat', () => {
  it('gains no tool: it cannot run the checks, nor cancel them', () => {
    expect([...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS].sort()).toEqual(
      [
        'list_projects',
        'show_project',
        'search_library',
        'read_note',
        'list_sessions',
        'session_panel',
        'show_usage',
        'show_settings',
        'list_suggestions',
        'list_proposals',
        'show_proposal',
        'list_skills',
        'list_tasks',
        'show_task',
        'start_creation',
        'cancel_creation',
        'start_task',
        'propose_note_change',
        'set_usage_profile',
        'prepare_improvement',
        'add_skill',
        'add_skill_to_project',
      ].sort(),
    );
  });
});

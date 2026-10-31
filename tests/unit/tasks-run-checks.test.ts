import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProjectChecks, taskChecksWith, type TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager, type TaskView } from '../../src/tasks/manager.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// Declared checks run only when the user asks on the proposal page, on the
// commit they reviewed (decisions.md, S8).

useHermeticGit();

let world: TaskWorld;
let creations: string[];

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** A check command that runs on Windows (`cmd`) and elsewhere (`sh`). */
const nodeCommand = (code: string) => `node -e "${code}"`;
/** Leaves a file where the clean-up keeps it (ignored), so a test can tell the check ran. */
const MARK = nodeCommand("require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ran.txt','x')");
/** Prints the reviewed file and leaves an untracked one the clean-up removes. */
const READ = nodeCommand("console.log(require('fs').readFileSync('CHANGES.md','utf8').trim());require('fs').writeFileSync('left.txt','x')");

function manager(options: { script?: TaskFakeScript; checks?: TaskChecks; maxActive?: number } = {}): TaskManager {
  return new TaskManager({
    runner: new TaskFakeRunner(options.script === undefined ? {} : { script: options.script }),
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    creations: { activeIds: () => creations, folderHolder: () => undefined },
    maxActive: () => options.maxActive ?? 2,
    pollMs: 10,
    checks: options.checks ?? taskChecksWith({ libraryDir: async () => world.library, home: world.home }),
  });
}

/** A project with confirmed checks, and a task on it waiting on its proposal (round 1 wrote CHANGES.md). */
async function proposal(m: TaskManager, commands: string[] = [READ]): Promise<TaskView> {
  await world.project('garden');
  await world.initLibrary();
  if (commands.length > 0) await setProjectChecks({ libraryDir: world.library, home: world.home, slug: 'garden', commands });
  const task = await m.start('garden', 'Add a changelog.');
  await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
  m.finishRound(task.id);
  await until(async () => (await m.get(task.id)).state === 'proposal', 'the proposal');
  return m.get(task.id);
}

const settled = (m: TaskManager, id: string) => until(async () => (await m.get(id)).state !== 'checking', 'the checks to end');
const ran = (worktree: string) => stat(path.join(worktree, 'node_modules', 'ran.txt')).then(
  () => true,
  () => false,
);

beforeEach(async () => {
  world = await taskWorld('tasks-run-checks');
  creations = [];
});
afterEach(() => world.cleanup());

describe('running the checks from the proposal page', { timeout: 60_000 }, () => {
  it('runs the confirmed checks on the reviewed commit, cleans up after them, and a new run replaces the results', async () => {
    const m = manager();
    const task = await proposal(m);
    // The round's end ran none: not run until the user asks.
    expect(task.checks).toBeUndefined();
    expect((await m.proposal(task.id)).checkCommands).toEqual([READ]);
    const worktree = world.store.worktreeDir(task.id);

    const started = await m.runChecks(task.id, [READ]);
    expect(started.state).toBe('checking');
    expect(m.activeIds()).toEqual([task.id]);
    await settled(m, task.id);
    const done = await m.get(task.id);
    expect(done).toMatchObject({ state: 'proposal', reviewed: task.reviewed });
    expect(done.checks).toHaveLength(1);
    expect(done.checks?.[0]).toMatchObject({ command: READ, exitCode: 0, timedOut: false });
    expect(done.checks?.[0]?.output).toContain('Round 1.');
    await expect(stat(path.join(worktree, 'left.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(m.activeIds()).toEqual([]);

    await setProjectChecks({ libraryDir: world.library, home: world.home, slug: 'garden', commands: [MARK] });
    await m.runChecks(task.id, [MARK]);
    await settled(m, task.id);
    const again = await m.get(task.id);
    expect(again.state).toBe('proposal');
    expect(again.checks?.map((check) => check.command)).toEqual([MARK]);
    expect(await ran(worktree)).toBe(true);
    await m.shutdown();
  });

  it('a round\'s end runs none of the confirmed checks, with the real checks wired in', async () => {
    const m = manager();
    // MARK, confirmed, would leave a file in an ignored folder that no clean-up removes.
    const task = await proposal(m, [MARK]);
    const worktree = world.store.worktreeDir(task.id);
    expect(task.checks).toBeUndefined();
    expect(await ran(worktree)).toBe(false);
    await m.newRound(task.id, 'More.');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    m.finishRound(task.id);
    await until(async () => (await m.get(task.id)).state === 'proposal', 'the second proposal');
    expect(await ran(worktree)).toBe(false);
    await m.shutdown();
  });

  it('refuses from any state but a proposal, and without confirmed checks', async () => {
    const m = manager({ script: () => ({ steps: [{ kind: 'write', file: 'CHANGES.md', content: 'x\n' }, { kind: 'end', summary: 'x' }] }) });
    const task = await proposal(m, []);
    await expect(m.runChecks(task.id, [])).rejects.toMatchObject({ code: 'task.noChecks', params: { project: 'garden' } });
    // A check in the note that the user never confirmed does not count.
    const note = path.join(world.library, 'projects', 'garden.md');
    await writeFile(note, `${await readFile(note, 'utf8')}\n## Checks\n\n\`\`\`briefstack-checks\n${MARK}\n\`\`\`\n`, 'utf8');
    await expect(m.runChecks(task.id, [MARK])).rejects.toMatchObject({ code: 'task.noChecks' });
    expect((await m.proposal(task.id)).checkCommands).toEqual([]);

    await setProjectChecks({ libraryDir: world.library, home: world.home, slug: 'garden', commands: [MARK] });
    await m.newRound(task.id, 'More.');
    await expect(m.runChecks(task.id, [MARK])).rejects.toMatchObject({ code: 'task.wrongState', params: { state: 'running' } });
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    m.finishRound(task.id);
    await until(async () => (await m.get(task.id)).state === 'proposal', 'the proposal');
    await m.discard(task.id);
    await expect(m.runChecks(task.id, [MARK])).rejects.toMatchObject({ code: 'task.wrongState', params: { state: 'discarded' } });
    await expect(m.runChecks('abcdef-0000', [MARK])).rejects.toMatchObject({ code: 'task.notFound' });
    await m.shutdown();
  });

  it('counts against the shared limit, and nothing else happens on the task while they run', async () => {
    let release: (() => void) | undefined;
    const slow: TaskChecks = { commands: async () => [MARK], run: () => new Promise((resolve) => (release = () => resolve([]))) };
    const m = manager({ maxActive: 1, checks: slow });
    const task = await proposal(m, []);
    // A creation holds the only place.
    creations = ['creation-1'];
    await expect(m.runChecks(task.id, [MARK])).rejects.toMatchObject({ code: 'task.limit' });
    creations = [];
    expect((await m.runChecks(task.id, [MARK])).state).toBe('checking');
    await expect(m.runChecks(task.id, [MARK])).rejects.toMatchObject({ code: 'task.wrongState', params: { state: 'checking' } });
    await expect(m.approve(task.id)).rejects.toMatchObject({ code: 'task.wrongState' });
    await expect(m.discard(task.id)).rejects.toMatchObject({ code: 'task.wrongState' });
    await expect(m.newRound(task.id, 'More.')).rejects.toMatchObject({ code: 'task.wrongState' });
    // The diff the user saw stays on the page meanwhile.
    expect((await m.proposal(task.id)).diff?.files.map((file) => file.path)).toEqual(['CHANGES.md']);
    await until(() => release !== undefined, 'the checks to start');
    release?.();
    await settled(m, task.id);
    expect((await m.get(task.id)).state).toBe('proposal');
    await m.shutdown();
  });

  it('runs nothing when the confirmed checks are no longer the list the confirmation showed (I1)', async () => {
    let confirmed = ['npm test', 'npm run lint'];
    const calls: string[][] = [];
    const spy: TaskChecks = { commands: async () => [...confirmed], run: async (_dir, commands) => (calls.push([...commands]), []) };
    const m = manager({ checks: spy });
    const task = await proposal(m, []);
    // The page opened its confirmation with this list.
    const shown = (await m.proposal(task.id)).checkCommands ?? [];
    expect(shown).toEqual(['npm test', 'npm run lint']);
    // The list changed before the user confirmed (another tab, or the file rewritten): one more, one less, another order, one changed.
    for (const next of [
      ['npm test', 'npm run lint', 'node evil.js'],
      ['npm test'],
      ['npm run lint', 'npm test'],
      ['npm test', 'npm run lint -- --fix'],
    ]) {
      confirmed = next;
      await expect(m.runChecks(task.id, shown)).rejects.toMatchObject({ code: 'task.checksChanged', params: { project: 'garden' } });
      expect((await m.get(task.id)).state).toBe('proposal');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    expect(m.activeIds()).toEqual([]);

    // Shown again as it is now and confirmed: it runs that list.
    const now = (await m.proposal(task.id)).checkCommands ?? [];
    await m.runChecks(task.id, now);
    await settled(m, task.id);
    expect(calls).toEqual([confirmed]);
    await m.shutdown();
  });

  it('fails without running anything when the branch moved after the review', async () => {
    const m = manager();
    const task = await proposal(m, [MARK]);
    const worktree = world.store.worktreeDir(task.id);
    await writeTree(worktree, { 'late.txt': 'added after the review\n' });
    await commitAll(worktree, 'late');
    await m.runChecks(task.id, [MARK]);
    await settled(m, task.id);
    const failed = await m.get(task.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('branch changed');
    expect(failed.reviewed).toBeUndefined();
    expect(failed.checks).toBeUndefined();
    expect(await ran(worktree)).toBe(false);
    await expect(m.approve(task.id)).rejects.toMatchObject({ code: 'task.wrongState' });
    await m.shutdown();
  });

  it('touches no copy whose .git no longer points at the task', async () => {
    const m = manager();
    const task = await proposal(m, [MARK]);
    const worktree = world.store.worktreeDir(task.id);
    const before = await readFile(path.join(worktree, '.git'), 'utf8');
    await rm(path.join(worktree, '.git'), { force: true });
    await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(task.projectDir, '.git')}\n`, 'utf8');
    await m.runChecks(task.id, [MARK]);
    await settled(m, task.id);
    const failed = await m.get(task.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('no longer points');
    expect(await ran(worktree)).toBe(false);
    expect((await gitIn(task.projectDir, 'rev-parse', 'HEAD')).trim()).toBe(task.baseCommit);
    await rm(path.join(worktree, '.git'), { force: true });
    await writeFile(path.join(worktree, '.git'), before, 'utf8');
    await m.shutdown();
  });
});

describe('actions at once on a task the server has not loaded yet (I2)', { timeout: 60_000 }, () => {
  /** A promise the test settles. */
  const gate = () => {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };

  /** A task on its proposal, left by a server that stopped: the next one has not loaded it. */
  async function recovered(): Promise<TaskView> {
    const m = manager();
    const task = await proposal(m, []);
    await m.shutdown();
    return task;
  }

  /** One of the two orders, never an applied task overwritten: applied with no checks run, or checked and still a proposal. */
  async function expectOneOrder(m: TaskManager, id: string, approve: PromiseSettledResult<TaskView>, check: PromiseSettledResult<TaskView>, calls: string[][]): Promise<void> {
    await settled(m, id);
    const live = await m.get(id);
    // The record on disk follows the one in memory once its save ends.
    await until(async () => (await world.store.load(id))?.state === live.state, 'the record on disk');
    if (approve.status === 'fulfilled') {
      expect(check).toMatchObject({ status: 'rejected', reason: { code: 'task.wrongState', params: { state: 'applied' } } });
      expect(live.state).toBe('applied');
      expect(live.applied).toBeDefined();
      expect(calls).toEqual([]);
    } else {
      expect(approve).toMatchObject({ status: 'rejected', reason: { code: 'task.wrongState' } });
      expect(check.status).toBe('fulfilled');
      expect(live.state).toBe('proposal');
      expect(live.checks).toEqual([]);
      expect(calls).toEqual([['npm test']]);
    }
    expect(live.state).not.toBe('failed');
  }

  it('checks asked first, approve while they read the list: approve waits, and the checks keep the task', async () => {
    const task = await recovered();
    const reading = gate();
    const calls: string[][] = [];
    const m = manager({ checks: { commands: async () => (await reading.promise, ['npm test']), run: async (_dir, commands) => (calls.push([...commands]), []) } });
    expect(await m.recover()).toBe(0);
    const check = m.runChecks(task.id, ['npm test']);
    const approve = m.approve(task.id);
    // Give approve every chance to run before the checks go on.
    await new Promise((resolve) => setTimeout(resolve, 300));
    reading.open();
    const [approved, checked] = await Promise.allSettled([approve, check]);
    await expectOneOrder(m, task.id, approved, checked, calls);
    await m.shutdown();
  });

  it('approve asked first, checks while it works: the checks wait, and the applied task stays applied', async () => {
    const task = await recovered();
    const applying = gate();
    let hold = false;
    const calls: string[][] = [];
    const m = new TaskManager({
      runner: new TaskFakeRunner(),
      store: world.store,
      sessionsDir: world.sessions,
      // Approving reads the locations first: held there, so the checks are asked while it works.
      locations: async () => {
        if (hold) await applying.promise;
        return { libraryDir: world.library, repoDir: world.repo };
      },
      lang: () => 'en',
      profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
      maxActive: () => 2,
      pollMs: 10,
      checks: { commands: async () => ['npm test'], run: async (_dir, commands) => (calls.push([...commands]), await new Promise((resolve) => setTimeout(resolve, 300)), []) },
    });
    hold = true;
    const approve = m.approve(task.id);
    const check = m.runChecks(task.id, ['npm test']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    applying.open();
    const [approved, checked] = await Promise.allSettled([approve, check]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expectOneOrder(m, task.id, approved, checked, calls);
    await m.shutdown();
  });

  it('discard and a new round asked meanwhile wait too, and find the checks running', async () => {
    const task = await recovered();
    const reading = gate();
    const finishing = gate();
    const calls: string[][] = [];
    const m = manager({ checks: { commands: async () => (await reading.promise, ['npm test']), run: async (_dir, commands) => (calls.push([...commands]), await finishing.promise, []) } });
    const check = m.runChecks(task.id, ['npm test']);
    const discard = m.discard(task.id);
    const round = m.newRound(task.id, 'More.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    reading.open();
    const [checked, discarded, again] = await Promise.allSettled([check, discard, round]);
    expect(checked.status).toBe('fulfilled');
    expect(discarded).toMatchObject({ status: 'rejected', reason: { code: 'task.wrongState', params: { state: 'checking' } } });
    expect(again).toMatchObject({ status: 'rejected', reason: { code: 'task.wrongState', params: { state: 'checking' } } });
    finishing.open();
    await settled(m, task.id);
    expect(await m.get(task.id)).toMatchObject({ state: 'proposal', checks: [] });
    // The record on disk follows the one in memory once its save ends.
    await until(async () => (await world.store.load(task.id))?.state === 'proposal', 'the record on disk');
    expect(calls).toEqual([['npm test']]);
    // The worktree is still there for the user's next step.
    await expect(stat(world.store.worktreeDir(task.id))).resolves.toBeDefined();
    await m.shutdown();
  });
});

describe('a server stop while the checks run (M2)', { timeout: 60_000 }, () => {
  /** Writes its pid where the clean-up keeps it, then runs for a minute. */
  const LONG = nodeCommand("require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/pid.txt',String(process.pid));setTimeout(()=>{},60000)");
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('kills the running command, records nothing, and the next start puts the task back on its proposal', async () => {
    const m = manager();
    const task = await proposal(m, [LONG]);
    const worktree = world.store.worktreeDir(task.id);
    await m.runChecks(task.id, [LONG]);
    const pidFile = path.join(worktree, 'node_modules', 'pid.txt');
    await until(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '', 'the command to start');
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    const before = Date.now();
    await m.shutdown();
    // Not the command's minute: the stop ended it.
    expect(Date.now() - before).toBeLessThan(20_000);
    await until(() => !alive(pid), 'the command to end');
    // Left as an abrupt stop leaves it.
    expect((await world.store.load(task.id))?.state).toBe('checking');

    const fresh = manager();
    expect(await fresh.recover()).toBe(1);
    const back = await fresh.get(task.id);
    expect(back).toMatchObject({ state: 'proposal', reviewed: task.reviewed });
    expect(back.checks).toBeUndefined();
    await fresh.shutdown();
  });

  it('does not wait past its limit for checks that do not end', async () => {
    const stuck: TaskChecks = { commands: async () => [MARK], run: () => new Promise(() => undefined) };
    const m = new TaskManager({
      runner: new TaskFakeRunner(),
      store: world.store,
      sessionsDir: world.sessions,
      locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
      lang: () => 'en',
      profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
      maxActive: () => 2,
      pollMs: 10,
      checks: stuck,
      shutdownTimeoutMs: 200,
    });
    const task = await proposal(m, []);
    await m.runChecks(task.id, [MARK]);
    const before = Date.now();
    await m.shutdown();
    expect(Date.now() - before).toBeLessThan(5_000);
    expect((await world.store.load(task.id))?.state).toBe('checking');
  });
});

describe('after a server stop during the checks', { timeout: 60_000 }, () => {
  it('goes back to the proposal without results, removes what they left, and does not run them again', async () => {
    const m = manager();
    const task = await proposal(m, [MARK]);
    await m.shutdown();
    const worktree = world.store.worktreeDir(task.id);
    // As the last server left it: checking, results gone, a file a check was writing.
    const record = await world.store.load(task.id);
    if (record === undefined) throw new Error('no record');
    await world.store.save({ ...record, state: 'checking' });
    await writeTree(worktree, { 'half.txt': 'x\n' });

    const calls: string[][] = [];
    const fresh = manager({ checks: { commands: async () => [MARK], run: async (_dir, commands) => (calls.push([...commands]), []) } });
    expect(await fresh.recover()).toBe(1);
    const back = await fresh.get(task.id);
    expect(back).toMatchObject({ state: 'proposal', reviewed: task.reviewed });
    expect(back.checks).toBeUndefined();
    expect(back.validations).toEqual(task.validations);
    await expect(stat(path.join(worktree, 'half.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual([]);
    expect((await fresh.proposal(task.id)).diff?.files.map((file) => file.path)).toEqual(['CHANGES.md']);
    // The user can still run them, and approve.
    await fresh.runChecks(task.id, [MARK]);
    await settled(fresh, task.id);
    expect(calls).toEqual([[MARK]]);
    expect((await fresh.approve(task.id)).state).toBe('applied');
    await fresh.shutdown();
  });

  it('fails a task cut short whose branch moved', async () => {
    const m = manager();
    const task = await proposal(m, [MARK]);
    await m.shutdown();
    const worktree = world.store.worktreeDir(task.id);
    await writeTree(worktree, { 'late.txt': 'x\n' });
    await commitAll(worktree, 'late');
    const record = await world.store.load(task.id);
    if (record === undefined) throw new Error('no record');
    await world.store.save({ ...record, state: 'checking' });
    const fresh = manager();
    expect(await fresh.recover()).toBe(1);
    const failed = await fresh.get(task.id);
    expect(failed.state).toBe('failed');
    expect(failed.reviewed).toBeUndefined();
  });

  it('still marks a round cut short while the server committed it as interrupted', async () => {
    const m = manager();
    const task = await proposal(m, [MARK]);
    await m.shutdown();
    const record = await world.store.load(task.id);
    if (record === undefined) throw new Error('no record');
    const cut = { ...record, state: 'checking' as const };
    delete cut.reviewed;
    await world.store.save(cut);
    expect(await manager().recover()).toBe(1);
    expect((await world.store.load(task.id))?.state).toBe('interrupted');
  });
});

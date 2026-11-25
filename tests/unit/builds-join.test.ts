import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIntegrationBranch, integrationHead, moveIntegration, prepareJoin } from '../../src/builds/git.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager, type UnattendedRound } from '../../src/tasks/manager.js';
import { buildBranchOf, type CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// Several cards of one build at once, and their join onto the integration
// branch (BRIEF-phase-11 §2, 9 and §4; PLAN-phase-11 M2; decisions.md,
// "Phase 11: H0", 2 and 3): each card its own worktree; joined one at a time
// with merge-tree from its start onto the head; checked again on the joined
// commit when the head moved; the compare and swap lets one join win.

useHermeticGit();

let world: TaskWorld;
let project: string;
const BUILD = 'mbld11-0a0b';
const BRANCH = buildBranchOf(BUILD);

/** A round waits for each `WAIT <ms>` line of its prompt and writes each `WRITE <file>: <text>` line. */
const writes: TaskFakeScript = (_round, prompt) => ({
  steps: [
    ...[...prompt.matchAll(/^WAIT (\d+)$/gm)].map((match) => ({ kind: 'wait' as const, ms: Number(match[1]) })),
    ...[...prompt.matchAll(/^WRITE (\S+): (.*)$/gm)].map((match) => ({ kind: 'write' as const, file: match[1] as string, content: `${match[2] as string}\n` })),
    { kind: 'end' as const, summary: 'Done.' },
  ],
});

interface CheckSpy {
  checks: TaskChecks;
  /** Each run: the folder's name and which of A.md and B.md it held. */
  runs: { dir: string; files: string[] }[];
}

/** Checks that fail when `fails` says so for the folder they run in. */
function spyChecks(fails: (files: string[]) => boolean = () => false, gate?: Promise<void>): CheckSpy {
  const runs: CheckSpy['runs'] = [];
  return {
    runs,
    checks: {
      commands: async () => [],
      run: async (dir, commands, signal): Promise<CheckResult[]> => {
        const files: string[] = [];
        for (const name of ['A.md', 'B.md', 'C.md']) if (await access(path.join(dir, name)).then(() => true, () => false)) files.push(name);
        runs.push({ dir: path.basename(dir), files });
        if (gate !== undefined) await Promise.race([gate, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
        const failed = fails(files) || signal?.aborted === true;
        return commands.map((command) => ({ command, exitCode: failed ? 1 : 0, timedOut: false, output: failed ? 'FAIL' : 'ok', durationMs: 1 }));
      },
    },
  };
}

function manager(checks: TaskChecks, maxActive = 4): TaskManager {
  return new TaskManager({
    runner: new TaskFakeRunner({ script: writes }),
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => maxActive,
    pollMs: 10,
    afterRound: afterRoundWith(),
    checks,
    buildOn: () => BUILD,
  });
}

const round = (prompt: string): UnattendedRound => ({ commands: ['npm test'], prompt, onDenied: () => undefined });

beforeEach(async () => {
  world = await taskWorld('builds-join');
  project = await world.project('garden', { 'README.md': 'Garden.\n', 'shared.txt': 'one\ntwo\nthree\n' });
});
afterEach(() => world.cleanup());

async function integration(): Promise<string> {
  const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
  await createIntegrationBranch(project, BRANCH, base);
  return base;
}

/** Starts a card of the build at `head` writing what `prompt` says, and waits for its round's end. */
async function card(m: TaskManager, n: number, head: string, prompt: string) {
  const task = await m.startForBuild('garden', { build: { id: BUILD, n }, base: { branch: BRANCH, commit: head }, description: `Card ${n}.`, round: round(prompt) });
  return task;
}

describe('prepareJoin and moveIntegration', () => {
  it('join a change onto a moved head, name the files of a conflict, see nothing new, and move the branch only from the head read', async () => {
    const base = await integration();
    const side = async (name: string, files: Record<string, string>) => {
      const dir = path.join(world.dir, name);
      await gitIn(project, 'worktree', 'add', '--quiet', '-b', `side-${name}`, dir, base);
      await writeTree(dir, files);
      const head = await commitAll(dir, name);
      await gitIn(project, 'worktree', 'remove', '--force', dir);
      return head;
    };
    const a = await side('a', { 'A.md': 'a\n' });
    const b = await side('b', { 'B.md': 'b\n' });
    const c = await side('c', { 'A.md': 'not a\n' });
    const first = await prepareJoin(project, { from: base, onto: base, to: a, message: 'a' });
    expect(first.kind).toBe('commit');
    const firstCommit = (first as { commit: string }).commit;
    await moveIntegration(project, BRANCH, firstCommit, base);
    const second = await prepareJoin(project, { from: base, onto: firstCommit, to: b, message: 'b' });
    expect(second.kind).toBe('commit');
    const joined = (second as { commit: string }).commit;
    expect((await gitIn(project, 'show', `${joined}:A.md`)).trim()).toBe('a');
    expect((await gitIn(project, 'show', `${joined}:B.md`)).trim()).toBe('b');
    expect((await gitIn(project, 'rev-parse', `${joined}^`)).trim()).toBe(firstCommit);
    expect(await prepareJoin(project, { from: base, onto: firstCommit, to: c, message: 'c' })).toEqual({ kind: 'conflict', files: ['A.md'] });
    expect(await prepareJoin(project, { from: base, onto: firstCommit, to: a, message: 'a again' })).toEqual({ kind: 'empty' });
    // Nothing moved the branch: only moveIntegration does, and only from the head it is given.
    expect(await integrationHead(project, BRANCH)).toBe(firstCommit);
    await expect(moveIntegration(project, BRANCH, joined, base)).rejects.toMatchObject({ code: 'build.branchMoved' });
    await moveIntegration(project, BRANCH, joined, firstCommit);
    expect(await integrationHead(project, BRANCH)).toBe(joined);
  });
});

describe('several cards of one build at once', () => {
  it('each runs in its own worktree from the same head; the first joins as phase 9 applied, the second is checked on the joined commit then joined', async () => {
    const base = await integration();
    const spy = spyChecks();
    const m = manager(spy.checks);
    try {
      const one = await card(m, 1, base, 'WRITE A.md: a');
      const two = await card(m, 2, base, 'WRITE B.md: b');
      expect(m.activeIds().sort()).toEqual([one.id, two.id].sort());
      expect(world.store.worktreeDir(one.id)).not.toBe(world.store.worktreeDir(two.id));
      await Promise.all([m.roundSettled(one.id), m.roundSettled(two.id)]);
      const first = await m.joinForBuild(one.id, ['npm test']);
      expect(first).toMatchObject({ kind: 'applied', merged: false, onto: base });
      // Where the card started: its own tree, no second run of the checks.
      expect(spy.runs).toEqual([]);
      const firstCommit = await integrationHead(project, BRANCH);
      const second = await m.joinForBuild(two.id, ['npm test']);
      expect(second).toMatchObject({ kind: 'applied', merged: true, onto: firstCommit, checks: [{ command: 'npm test', exitCode: 0 }] });
      // The checks ran on the joined commit, both cards' files there, in the temporary worktree, which is gone.
      expect(spy.runs).toEqual([{ dir: 'join', files: ['A.md', 'B.md'] }]);
      await expect(access(world.store.joinDir(two.id))).rejects.toBeDefined();
      const head = (await integrationHead(project, BRANCH)) as string;
      expect(second.kind === 'applied' && second.task.applied?.commit).toBe(head);
      expect((await gitIn(project, 'rev-parse', `${head}^`)).trim()).toBe(firstCommit);
      expect(await readFile(path.join(project, 'README.md'), 'utf8')).toBe('Garden.\n');
      // Each card's worktree and branch are gone; only the project's folder is left.
      expect((await gitIn(project, 'worktree', 'list', '--porcelain')).split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length).toBe(1);
      expect((await gitIn(project, 'branch', '--list', 'briefstack/task-*')).trim()).toBe('');
    } finally {
      await m.shutdown();
    }
  });

  it('a textual conflict, or checks failing only on the joined commit, are answered and nothing moves', async () => {
    const base = await integration();
    // The checks fail only where A.md and B.md are together: never in a card's own worktree.
    const spy = spyChecks((files) => files.includes('A.md') && files.includes('B.md'));
    const m = manager(spy.checks);
    try {
      const one = await card(m, 1, base, 'WRITE A.md: a');
      const clash = await card(m, 2, base, 'WRITE A.md: other a');
      const two = await card(m, 3, base, 'WRITE B.md: b');
      await Promise.all([one, clash, two].map((task) => m.roundSettled(task.id)));
      expect(await m.joinForBuild(one.id, ['npm test'])).toMatchObject({ kind: 'applied' });
      const head = await integrationHead(project, BRANCH);
      expect(await m.joinForBuild(clash.id, ['npm test'])).toEqual({ kind: 'conflict', onto: head, files: ['A.md'] });
      const failed = await m.joinForBuild(two.id, ['npm test']);
      expect(failed).toMatchObject({ kind: 'checksFailed', onto: head, checks: [{ exitCode: 1 }] });
      expect(await integrationHead(project, BRANCH)).toBe(head);
      // Both stay proposals the build can redo or leave waiting; the temporary worktree is gone.
      expect((await m.get(clash.id)).state).toBe('proposal');
      expect((await m.get(two.id)).state).toBe('proposal');
      await expect(access(world.store.joinDir(two.id))).rejects.toBeDefined();
      // The build's own discard of a card it redoes.
      expect((await m.discardForBuild(clash.id)).state).toBe('discarded');
    } finally {
      await m.shutdown();
    }
  });

  it('two joins racing on the compare and swap: one moves the branch, the other is told the head moved', async () => {
    const base = await integration();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const spy = spyChecks(() => false, gate);
    const m = manager(spy.checks);
    try {
      // A first card joined, so the two others join onto a head that moved and run their checks.
      const zero = await card(m, 1, base, 'WRITE C.md: c');
      await m.roundSettled(zero.id);
      await m.joinForBuild(zero.id, []);
      const one = await card(m, 2, base, 'WRITE A.md: a');
      const two = await card(m, 3, base, 'WRITE B.md: b');
      await Promise.all([m.roundSettled(one.id), m.roundSettled(two.id)]);
      const racing = Promise.all([m.joinForBuild(one.id, ['npm test']), m.joinForBuild(two.id, ['npm test'])]);
      for (let i = 0; i < 500 && spy.runs.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spy.runs.length).toBe(2);
      // Both are checking: they count in the shared limit.
      expect(m.activeIds().sort()).toEqual([one.id, two.id].sort());
      open();
      const kinds = (await racing).map((result) => result.kind).sort();
      expect(kinds).toEqual(['applied', 'moved']);
    } finally {
      open();
      await m.shutdown();
    }
  });

  it('a stop during the checks on a joined commit ends them; recover() puts the card back on its proposal and removes their worktree', async () => {
    const base = await integration();
    const spy = spyChecks(() => false, new Promise<void>(() => undefined));
    const m = manager(spy.checks);
    const zero = await card(m, 1, base, 'WRITE C.md: c');
    await m.roundSettled(zero.id);
    await m.joinForBuild(zero.id, []);
    const one = await card(m, 2, base, 'WRITE A.md: a');
    await m.roundSettled(one.id);
    const joining = m.joinForBuild(one.id, ['npm test']);
    for (let i = 0; i < 500 && spy.runs.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const head = await integrationHead(project, BRANCH);
    await m.shutdown();
    expect(await joining).toEqual({ kind: 'aborted' });
    expect(await integrationHead(project, BRANCH)).toBe(head);
    const fresh = manager(spyChecks().checks);
    await fresh.recover();
    expect((await fresh.get(one.id)).state).toBe('proposal');
    await expect(access(world.store.joinDir(one.id))).rejects.toBeDefined();
    await fresh.shutdown();
  });

  it('refuses a task without a build, and a full shared limit before the checks on a joined commit', async () => {
    const base = await integration();
    const m = manager(spyChecks().checks, 1);
    try {
      const ordinary = await (async () => {
        const plain = new TaskManager({
          runner: new TaskFakeRunner(),
          store: world.store,
          sessionsDir: world.sessions,
          locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
          lang: () => 'en',
          profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
          pollMs: 10,
          afterRound: afterRoundWith(),
        });
        await world.project('orchard');
        const task = await plain.start('orchard', 'Write a note.');
        await plain.shutdown();
        return task.id;
      })();
      await expect(m.joinForBuild(ordinary, ['npm test'])).rejects.toMatchObject({ code: 'task.notInBuild' });
      await expect(m.discardForBuild(ordinary)).rejects.toMatchObject({ code: 'task.notInBuild' });
      const zero = await card(m, 1, base, 'WRITE C.md: c');
      await m.roundSettled(zero.id);
      await m.joinForBuild(zero.id, []);
      const one = await card(m, 2, base, 'WRITE A.md: a');
      await m.roundSettled(one.id);
      const blocker = await card(m, 3, (await integrationHead(project, BRANCH)) as string, 'WAIT 1500\nWRITE B.md: b');
      // The third card's round holds the one place: the join's checks wait for it.
      await expect(m.joinForBuild(one.id, ['npm test'])).rejects.toMatchObject({ code: 'task.limit' });
      await m.roundSettled(blocker.id);
      expect(await m.joinForBuild(one.id, ['npm test'])).toMatchObject({ kind: 'applied', merged: true });
    } finally {
      await m.shutdown();
    }
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIntegrationBranch, integrationHead } from '../../src/builds/git.js';
import { readEvents, sessionEventsFile } from '../../src/events/index.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager, type UnattendedRound } from '../../src/tasks/manager.js';
import { UNATTENDED_DENIED, UNATTENDED_QUESTION } from '../../src/tasks/runner.js';
import { buildBranchOf, type CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// A build's tasks in the task manager (BRIEF-phase-9 §2, 5–7; PLAN-phase-9
// M2): they start at the integration branch, their rounds ask nobody, their
// checks run after the round only through `runBuildChecks`, and approving one
// applies it to the integration branch. Ordinary tasks keep the dialog and S8.

useHermeticGit();

let world: TaskWorld;
let project: string;
const BUILD = 'mbld01-0a0b';
const BRANCH = buildBranchOf(BUILD);

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** Checks that record their runs; each command passes unless it is in `failing`. */
function spyChecks(failing: string[] = []): { checks: TaskChecks; runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    checks: {
      commands: async () => ['npm test'],
      run: async (_dir, commands): Promise<CheckResult[]> => {
        runs.push([...commands]);
        return commands.map((command) => ({ command, exitCode: failing.includes(command) ? 1 : 0, timedOut: false, output: failing.includes(command) ? 'FAIL' : 'ok', durationMs: 1 }));
      },
    },
  };
}

/** A manager on which `BUILD` holds the project unless `buildOn` says otherwise. */
function manager(script: TaskFakeScript | undefined, checks: TaskChecks, buildOn: () => string | undefined = () => BUILD): { m: TaskManager; runner: TaskFakeRunner } {
  const runner = new TaskFakeRunner(script === undefined ? {} : { script });
  const m = new TaskManager({
    runner,
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 2,
    pollMs: 10,
    afterRound: afterRoundWith(),
    checks,
    buildOn,
  });
  return { m, runner };
}

function round(commands: string[] = ['npm test']): UnattendedRound & { denied: { tool: string; text: string }[] } {
  const denied: { tool: string; text: string }[] = [];
  return { commands, prompt: 'BUILD ROUND PROMPT', denied, onDenied: (entry) => denied.push(entry) };
}

beforeEach(async () => {
  world = await taskWorld('builds-tasks');
  project = await world.project('garden', { 'README.md': 'Garden.\n' });
});
afterEach(() => world.cleanup());

/** The integration branch at main's head, with one commit of its own (as after a first applied task). */
async function integration(): Promise<string> {
  const base = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
  await createIntegrationBranch(project, BRANCH, base);
  const work = path.join(world.dir, 'seed');
  await gitIn(project, 'worktree', 'add', '--quiet', work, BRANCH);
  await writeTree(work, { 'applied.txt': 'From the first task.\n' });
  const head = await commitAll(work, 'first task');
  await gitIn(project, 'worktree', 'remove', '--force', work);
  return head;
}

describe('a build\'s task', () => {
  it('starts at the integration head, asks nobody, and ends its round when its turn ends', async () => {
    const head = await integration();
    const r = round(['npm test', 'npm run lint']);
    const { m, runner } = manager(
      () => ({
        steps: [
          { kind: 'shell', command: 'npm test' },
          { kind: 'shell', command: 'npm test && npm run lint' },
          { kind: 'shell', command: 'curl https://example.com' },
          { kind: 'web', url: 'https://example.com' },
          { kind: 'question', questions: [{ question: 'Which?', header: 'Q', options: [{ label: 'A', description: '' }], multiSelect: false }] },
          { kind: 'write', file: 'NEW.md', content: 'New.\n' },
          { kind: 'end', summary: 'Done.' },
        ],
      }),
      spyChecks().checks,
    );
    try {
      const task = await m.startForBuild('garden', { build: { id: BUILD, n: 2 }, base: { branch: BRANCH, commit: head }, description: 'Add NEW.md.', round: r });
      expect(task.build).toEqual({ id: BUILD, n: 2 });
      expect(task.baseBranch).toBe(BRANCH);
      expect(task.baseCommit).toBe(head);
      expect(await readFile(path.join(world.store.worktreeDir(task.id), 'applied.txt'), 'utf8')).toBe('From the first task.\n');
      // Never a dialog, a question or a wait for a reply.
      const seen: string[] = [];
      m.subscribe(task.id, 0, (event) => seen.push(event.kind));
      const done = await m.roundSettled(task.id);
      expect(done.state).toBe('proposal');
      expect(seen).not.toContain('approval');
      expect(seen).not.toContain('question');
      expect(runner.started[0]?.unattended).toBe(true);
      expect(runner.started[0]?.prompt).toBe('BUILD ROUND PROMPT');
      expect(r.denied).toEqual([
        { tool: 'Bash', text: 'curl https://example.com' },
        { tool: 'WebFetch', text: 'https://example.com' },
      ]);
      // The denials, the refused question, and the allowed calls, as the panel reads them.
      const session = done.rounds[0]?.sessionId as string;
      const { events } = await readEvents(sessionEventsFile(world.sessions, session));
      const denials = events.filter((event) => (event as { type?: string }).type === 'tool.denied') as { tool?: string; by?: string; reason?: string }[];
      expect(denials.map((event) => [event.tool, event.by])).toEqual([
        ['Bash', 'policy'],
        ['WebFetch', 'policy'],
        ['AskUserQuestion', 'guard'],
      ]);
      expect(denials[0]?.reason).toBe(UNATTENDED_DENIED);
      expect(denials[2]?.reason).toBe(UNATTENDED_QUESTION);
      expect((await gitIn(project, 'show', `${done.reviewed as string}:NEW.md`)).trim()).toBe('New.');
    } finally {
      await m.shutdown();
    }
  });

  it('runs its checks after the round only through runBuildChecks, and a fix round is unattended too', async () => {
    const head = await integration();
    const { checks, runs } = spyChecks(['npm run lint']);
    const { m, runner } = manager(undefined, checks);
    try {
      const task = await m.startForBuild('garden', { build: { id: BUILD, n: 1 }, base: { branch: BRANCH, commit: head }, description: 'Write CHANGES.md.', round: round() });
      await m.roundSettled(task.id);
      expect(runs).toEqual([]);
      const checked = await m.runBuildChecks(task.id, ['npm test', 'npm run lint']);
      expect(runs).toEqual([['npm test', 'npm run lint']]);
      expect(checked.state).toBe('proposal');
      expect(checked.checks?.map((check) => check.exitCode)).toEqual([0, 1]);
      await m.newBuildRound(task.id, 'Fix the lint.', { ...round(), prompt: 'FIX ROUND PROMPT' });
      const fixed = await m.roundSettled(task.id);
      expect(fixed.state).toBe('proposal');
      expect(fixed.rounds.length).toBe(2);
      expect(runner.started[1]?.unattended).toBe(true);
      expect(runner.started[1]?.prompt).toBe('FIX ROUND PROMPT');
      expect(fixed.checks).toBeUndefined();
    } finally {
      await m.shutdown();
    }
  });

  it('is approved onto the integration branch, never the folder\'s branch, and only its build reverts it', async () => {
    const head = await integration();
    const { m } = manager(undefined, spyChecks().checks);
    try {
      const before = { branch: (await gitIn(project, 'symbolic-ref', '--short', 'HEAD')).trim(), head: (await gitIn(project, 'rev-parse', 'HEAD')).trim() };
      const task = await m.startForBuild('garden', { build: { id: BUILD, n: 1 }, base: { branch: BRANCH, commit: head }, description: 'Write CHANGES.md.', round: round() });
      await m.roundSettled(task.id);
      const applied = await m.approve(task.id);
      expect(applied.state).toBe('applied');
      expect(await integrationHead(project, BRANCH)).toBe(applied.applied?.commit);
      expect((await gitIn(project, 'rev-parse', `${applied.applied?.commit as string}^`)).trim()).toBe(head);
      expect({ branch: (await gitIn(project, 'symbolic-ref', '--short', 'HEAD')).trim(), head: (await gitIn(project, 'rev-parse', 'HEAD')).trim() }).toEqual(before);
      expect(await gitIn(project, 'status', '--porcelain')).toBe('');
      expect((await gitIn(project, 'branch', '--list', task.branch)).trim()).toBe('');
      await expect(m.revert(task.id)).rejects.toMatchObject({ code: 'task.inBuild' });
    } finally {
      await m.shutdown();
    }
  });
});

describe('ordinary tasks are unchanged (S8 and the dialog)', () => {
  it('an ordinary task still asks for a command, waits for the user after its turn, and its checks never run but on the user\'s request', async () => {
    const { checks, runs } = spyChecks();
    const { m } = manager(() => ({ steps: [{ kind: 'shell', command: 'npm test' }, { kind: 'end', summary: 'Done.' }] }), checks, () => undefined);
    try {
      const task = await m.start('garden', 'Run the tests.');
      await until(async () => (await m.get(task.id)).pending?.kind === 'approval', 'the dialog');
      const pending = (await m.get(task.id)).pending;
      m.answer(task.id, pending?.id as string, 'deny');
      await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
      expect((await m.get(task.id)).state).toBe('running');
      m.finishRound(task.id);
      await until(async () => (await m.get(task.id)).state === 'proposal', 'the proposal');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs).toEqual([]);
      await expect(m.runBuildChecks(task.id, ['npm test'])).rejects.toMatchObject({ code: 'task.notInBuild' });
      await expect(m.newBuildRound(task.id, 'x', round())).rejects.toMatchObject({ code: 'task.notInBuild' });
      expect(runs).toEqual([]);
    } finally {
      await m.shutdown();
    }
  });

  it('an open build holds the project for ordinary tasks', async () => {
    const { m } = manager(undefined, spyChecks().checks, () => BUILD);
    try {
      await expect(m.start('garden', 'Something.')).rejects.toMatchObject({ code: 'task.buildOnProject' });
      expect((await m.startInfo('garden')).ok).toBe(false);
    } finally {
      await m.shutdown();
    }
  });
});

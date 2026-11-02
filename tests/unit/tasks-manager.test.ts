import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager, type TaskStreamEvent, type TaskView } from '../../src/tasks/manager.js';
import { TASK_MARKER_FILE } from '../../src/tasks/runner.js';
import type { TaskRecord } from '../../src/tasks/types.js';
import { useHermeticGit } from '../helpers.js';
import { gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

useHermeticGit();

let world: TaskWorld;
let creations: string[];
let creationFolder: string | undefined;
let runner: TaskFakeRunner;

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

function manager(script?: TaskFakeScript, extra: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}): TaskManager {
  runner = new TaskFakeRunner(script === undefined ? {} : { script });
  return new TaskManager({
    runner,
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    creations: { activeIds: () => creations, folderHolder: () => creationFolder },
    maxActive: () => 2,
    pollMs: 10,
    ...extra,
  });
}

beforeEach(async () => {
  world = await taskWorld('tasks-manager');
  creations = [];
  creationFolder = undefined;
});

afterEach(() => world.cleanup());

const stateIs = (m: TaskManager, id: string, state: string) => until(async () => (await m.get(id)).state === state, `state ${state}`);

describe('TaskManager: a round', () => {
  it('works in a worktree, waits after its turn, and on finish commits the round on the task branch', async () => {
    const project = await world.project('garden');
    const m = manager();
    const task = await m.start('garden', 'Add a changelog.');
    expect(task).toMatchObject({ project: 'garden', state: 'running', profile: 'saver', model: 'sonnet', effort: 'low', baseBranch: 'main', branch: `briefstack/task-${task.id}` });
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    expect((await m.get(task.id)).awaitingReply?.lastMessage).toBe('Wrote CHANGES.md (round 1).');
    const worktree = world.store.worktreeDir(task.id);
    expect(await readFile(path.join(worktree, 'CHANGES.md'), 'utf8')).toBe('Round 1.\n');

    m.finishRound(task.id);
    await stateIs(m, task.id, 'proposal');
    const done = await m.get(task.id);
    expect(done.rounds).toHaveLength(1);
    expect(done.rounds[0]).toMatchObject({ n: 1, text: 'Add a changelog.', outcome: 'completed', summary: 'Wrote CHANGES.md (round 1).', commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect((await gitIn(project, 'log', '--format=%s', done.branch)).trim().split('\n')[0]).toBe(`briefstack task ${task.id}, round 1`);
    // The project folder is untouched: same branch, same commit, no CHANGES.md.
    expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(done.baseCommit);
    await expect(stat(path.join(project, 'CHANGES.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The prompt carries the task's text.
    expect(runner.started[0]?.prompt).toContain('Add a changelog.');
    expect(runner.started[0]).toMatchObject({ model: 'sonnet', effort: 'low', worktree, skills: [] });
  });

  it('records the session for the panel: the marker, its start and end, and tool lines on the worktree', async () => {
    await world.project('garden');
    const m = manager();
    const task = await m.start('garden', 'Add a changelog.');
    await until(async () => (await m.get(task.id)).rounds[0]?.sessionId !== undefined, 'the session id');
    m.finishRound(task.id);
    await stateIs(m, task.id, 'proposal');
    const session = (await m.get(task.id)).rounds[0]?.sessionId as string;
    const folder = path.join(world.sessions, session);
    expect(JSON.parse(await readFile(path.join(folder, TASK_MARKER_FILE), 'utf8'))).toEqual({ v: 1, taskId: task.id, project: 'garden', round: 1 });
    const lines = (await readFile(path.join(folder, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ source: 'flow', type: 'session.started' });
    expect(lines.find((line) => line.type === 'tool.pre')).toMatchObject({ tool: 'Write', target: { root: 'work', path: 'CHANGES.md' } });
    expect(lines.find((line) => line.type === 'session.profile')).toMatchObject({ profile: 'saver', model: 'sonnet', effort: 'low' });
    expect(lines.at(-1)).toMatchObject({ type: 'session.finished', outcome: 'completed' });
  });

  it('streams the round to a subscriber', async () => {
    await world.project('garden');
    const m = manager();
    const task = await m.start('garden', 'Add a changelog.');
    const seen: TaskStreamEvent[] = [];
    m.subscribe(task.id, 0, (event) => seen.push(event));
    await until(() => seen.some((event) => event.kind === 'hook'), 'a hook line');
    m.finishRound(task.id);
    await until(() => seen.some((event) => event.kind === 'status' && (event.data as { state: string }).state === 'proposal'), 'the proposal status');
    expect(seen.every((event) => event.round === 1)).toBe(true);
    expect(seen.map((event) => event.seq)).toEqual(seen.map((_, i) => i + 1));
  });

  it('takes a reply after the turn, and runs another turn', async () => {
    await world.project('garden');
    const m = manager();
    const task = await m.start('garden', 'Add a changelog.');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined);
    m.reply(task.id, 'Also mention the date.');
    await until(async () => (await m.get(task.id)).awaitingReply?.lastMessage === 'Read your reply: Also mention the date.');
    expect(() => m.reply('nope', 'x')).toThrow();
  });
});

describe('TaskManager: refusals at the start', () => {
  it('refuses what the preconditions refuse, and leaves nothing behind', async () => {
    await world.project('app', {}, { target: 'claude-app' });
    const m = manager();
    await expect(m.start('app', 'Do it.')).rejects.toMatchObject({ code: 'task.notClaudeCode' });
    await expect(m.start('missing', 'Do it.')).rejects.toMatchObject({ code: 'task.projectNotFound' });
    expect(await m.list()).toEqual([]);
  });

  it('refuses a project whose skills or agents declare hooks, and removes the worktree and branch it made', async () => {
    const project = await world.project('garden', { '.claude/skills/hooked/SKILL.md': '---\nname: hooked\ndescription: x\nhooks:\n  PreToolUse: []\n---\nGo.\n' });
    const m = manager();
    await expect(m.start('garden', 'Do it.')).rejects.toMatchObject({ code: 'task.unsafeDefinitions', params: { items: [{ file: '.claude/skills/hooked/SKILL.md', reason: 'hooks' }] } });
    expect(await m.list()).toEqual([]);
    expect((await gitIn(project, 'branch', '--list', 'briefstack/*')).trim()).toBe('');
    expect(await readdir(path.join(world.home, 'tasks')).catch(() => [])).toEqual([]);
  });

  it('allows one open task per project, and shares the active limit with creations', async () => {
    await world.project('garden');
    await world.project('orchard');
    const m = manager();
    const first = await m.start('garden', 'One.');
    await expect(m.start('garden', 'Two.')).rejects.toMatchObject({ code: 'task.projectBusy', params: { id: first.id } });
    creations = ['c1'];
    await expect(m.start('orchard', 'Three.')).rejects.toMatchObject({ code: 'task.limit', params: { limit: 2, active: [first.id, 'c1'] } });
    expect(m.activeIds()).toEqual([first.id]);
    creations = [];
    creationFolder = 'A new orchard';
    await expect(m.start('orchard', 'Three.')).rejects.toMatchObject({ code: 'task.creationOnFolder' });
  });

  it('runs two starts one after the other, so both cannot pass the limit', async () => {
    await world.project('garden');
    await world.project('orchard');
    const m = manager(undefined, { maxActive: () => 1 });
    const results = await Promise.allSettled([m.start('garden', 'One.'), m.start('orchard', 'Two.')]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('TaskManager: shell commands and questions', () => {
  const pendingOf = async (m: TaskManager, id: string): Promise<NonNullable<TaskView['pending']>> => {
    await until(async () => (await m.get(id)).pending !== undefined, 'a pending request');
    return (await m.get(id)).pending as NonNullable<TaskView['pending']>;
  };

  it('asks for each new command; "once" asks again, "this exact command" does not, across rounds too', async () => {
    await world.project('garden');
    const m = manager(() => ({
      steps: [
        { kind: 'shell', command: 'npm test' },
        { kind: 'shell', command: 'npm test' },
        { kind: 'shell', command: 'npm test' },
        { kind: 'shell', command: 'npm test && curl https://x.invalid' },
        { kind: 'end', summary: 'Done.' },
      ],
    }));
    const task = await m.start('garden', 'Test it.');
    let pending = await pendingOf(m, task.id);
    expect(pending).toMatchObject({ kind: 'approval', payload: { kind: 'shell', tool: 'Bash', text: 'npm test', compound: false, runsGit: false } });
    m.answer(task.id, pending.id, 'once');
    pending = await pendingOf(m, task.id);
    expect(pending.payload).toMatchObject({ text: 'npm test' });
    m.answer(task.id, pending.id, 'task');
    // The third "npm test" is not asked; the compound one is, and says so.
    pending = await pendingOf(m, task.id);
    expect(pending.payload).toMatchObject({ text: 'npm test && curl https://x.invalid', compound: true, features: ['and'] });
    m.answer(task.id, pending.id, 'deny');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined);
    expect((await m.get(task.id)).allowedForTask).toBe(1);
    const session = (await m.get(task.id)).rounds[0]?.sessionId as string;
    const events = path.join(world.sessions, session, 'events.jsonl');
    // The runner writes its lines in the background: the turn can end before the denial's line is on disk.
    await until(async () => (await readFile(events, 'utf8')).includes('"type":"tool.denied"'), 'the denial in the events');
    const lines = await readFile(events, 'utf8');
    expect(lines).toContain('"by":"user"');
    // Nothing of the command reaches the events file.
    expect(lines).not.toContain('curl');

    // Round 2 (ask for changes) still has "npm test" allowed for the task.
    m.finishRound(task.id);
    await stateIs(m, task.id, 'proposal');
    await m.newRound(task.id, 'Once more.');
    pending = await pendingOf(m, task.id);
    expect(pending.payload).toMatchObject({ text: 'npm test && curl https://x.invalid' });
    m.cancel(task.id);
    await stateIs(m, task.id, 'cancelled');
  });

  it('refuses wrong answers and answers to the wrong request', async () => {
    await world.project('garden');
    const m = manager(() => ({ steps: [{ kind: 'shell', command: 'ls' }, { kind: 'end', summary: 'x' }] }));
    const task = await m.start('garden', 'List.');
    const pending = await pendingOf(m, task.id);
    expect(() => m.answer(task.id, pending.id, 'always')).toThrow(expect.objectContaining({ code: 'creation.invalidAnswer' }));
    expect(() => m.answer(task.id, 'p99', 'once')).toThrow(expect.objectContaining({ code: 'creation.wrongPending' }));
    m.answer(task.id, pending.id, 'once');
  });

  it('denies a dialog nobody answers in time', async () => {
    await world.project('garden');
    const m = manager(() => ({ steps: [{ kind: 'shell', command: 'ls' }, { kind: 'end', summary: 'x' }] }), { dialogTimeoutMs: 30 });
    const task = await m.start('garden', 'List.');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end after the timeout');
    const session = (await m.get(task.id)).rounds[0]?.sessionId as string;
    await until(async () => (await readFile(path.join(world.sessions, session, 'events.jsonl'), 'utf8')).includes('tool.denied'));
  });

  it('asks questions, and a write outside the worktree is denied by the guard', async () => {
    await world.project('garden');
    const m = manager(() => ({
      steps: [
        { kind: 'question', questions: [{ question: 'Which file?', header: 'File', options: [{ label: 'A', description: '' }], multiSelect: false }] },
        { kind: 'writeOutside', file: path.join(world.dir, 'projects', 'garden', 'x.txt') },
        { kind: 'end', summary: 'x' },
      ],
    }));
    const task = await m.start('garden', 'Ask.');
    const pending = await pendingOf(m, task.id);
    expect(pending.kind).toBe('question');
    m.answer(task.id, pending.id, { 'Which file?': 'A' });
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined);
    const session = (await m.get(task.id)).rounds[0]?.sessionId as string;
    // The guard's denial line is written in the background: the turn can end before it is on disk.
    const events = path.join(world.sessions, session, 'events.jsonl');
    await until(async () => (await readFile(events, 'utf8')).includes('"type":"tool.denied"'), 'the denial in the events');
    expect(await readFile(events, 'utf8')).toContain('"by":"guard"');
    await expect(stat(path.join(world.dir, 'projects', 'garden', 'x.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels: the pending request is denied and the task is cancelled', async () => {
    await world.project('garden');
    const m = manager(() => ({ steps: [{ kind: 'shell', command: 'ls' }, { kind: 'end', summary: 'x' }] }));
    const task = await m.start('garden', 'List.');
    await pendingOf(m, task.id);
    expect(m.cancel(task.id).cancelling).toBe(true);
    await stateIs(m, task.id, 'cancelled');
    expect((await m.get(task.id)).rounds[0]).toMatchObject({ outcome: 'cancelled' });
    expect(m.activeIds()).toEqual([]);
  });

  it('marks a round that failed', async () => {
    await world.project('garden');
    const m = manager(() => ({ steps: [{ kind: 'fail', error: 'claude was not found at /opt/x' }] }));
    const task = await m.start('garden', 'Fail.');
    await stateIs(m, task.id, 'failed');
    expect((await m.get(task.id)).error).toBe('claude was not found at [outside allowed folders]');
  });
});

describe('TaskManager: the end of a round is shown once it is on disk', () => {
  /** A promise the test settles. */
  const gate = () => {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };

  /** Holds the first save `matches` picks until `release()`; `reached` opens when it is held. */
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

  const states = (seen: TaskStreamEvent[]) => seen.filter((event) => event.kind === 'status').map((event) => (event.data as { state: string }).state);

  it('a cancelled round: neither the task nor its stream show the end before its save', async () => {
    await world.project('garden');
    const m = manager(() => ({ steps: [{ kind: 'shell', command: 'ls' }, { kind: 'end', summary: 'x' }] }));
    const task = await m.start('garden', 'List.');
    await until(async () => (await m.get(task.id)).pending !== undefined, 'the dialog');
    const seen: TaskStreamEvent[] = [];
    m.subscribe(task.id, 0, (event) => seen.push(event));
    const held = holdSave((record) => record.id === task.id && record.rounds.at(-1)?.finishedAt !== undefined);
    m.cancel(task.id);
    await held.reached;
    const shown = await m.get(task.id);
    expect(shown.state).toBe('running');
    expect(shown.rounds.at(-1)?.finishedAt).toBeUndefined();
    expect(shown.rounds.at(-1)?.outcome).toBeUndefined();
    expect(states(seen)).not.toContain('cancelled');
    held.release();
    await stateIs(m, task.id, 'cancelled');
    expect((await m.get(task.id)).rounds.at(-1)).toMatchObject({ outcome: 'cancelled', finishedAt: expect.any(String) });
    expect(await world.store.load(task.id)).toMatchObject({ state: 'cancelled', rounds: [{ outcome: 'cancelled' }] });
  });

  it('a completed round: its end, then its commit, are shown only once each is on disk', async () => {
    await world.project('garden');
    const m = manager();
    const task = await m.start('garden', 'Add a changelog.');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    const seen: TaskStreamEvent[] = [];
    m.subscribe(task.id, 0, (event) => seen.push(event));
    const checking = holdSave((record) => record.id === task.id && record.state === 'checking');
    m.finishRound(task.id);
    await checking.reached;
    let shown = await m.get(task.id);
    expect(shown.state).toBe('running');
    expect(shown.rounds.at(-1)).not.toHaveProperty('finishedAt');
    expect(shown.rounds.at(-1)).not.toHaveProperty('summary');
    expect(states(seen)).not.toContain('checking');

    const proposal = holdSave((record) => record.id === task.id && record.state === 'proposal');
    checking.release();
    await proposal.reached;
    shown = await m.get(task.id);
    expect(shown.state).toBe('checking');
    expect(shown.rounds.at(-1)).toMatchObject({ outcome: 'completed', summary: 'Wrote CHANGES.md (round 1).' });
    expect(shown.rounds.at(-1)).not.toHaveProperty('commit');
    expect(shown.reviewed).toBeUndefined();
    expect(states(seen)).not.toContain('proposal');
    proposal.release();
    await stateIs(m, task.id, 'proposal');
    expect((await m.get(task.id)).rounds.at(-1)?.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('TaskManager: after a server stop', () => {
  it('marks tasks the last server left running as interrupted', async () => {
    await world.project('garden');
    const m = manager(() => ({ steps: [{ kind: 'wait', ms: 10_000 }] }));
    const task = await m.start('garden', 'Wait.');
    // The round's session id is saved in the background once the session opens. The task shows it as that save is asked,
    // and the saves of one task reach the disk in order, so the next server's save comes after it.
    await until(async () => (await m.get(task.id)).rounds[0]?.sessionId !== undefined, 'the session id');
    const fresh = manager();
    expect(await fresh.recover()).toBe(1);
    expect(await fresh.get(task.id)).toMatchObject({ state: 'interrupted', rounds: [{ outcome: 'interrupted' }] });
    await m.shutdown();
  });
});

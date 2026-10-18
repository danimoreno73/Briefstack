import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager, type CreationState, type StreamEvent } from '../../src/creation/manager.js';
import type { CreationRunner, PermissionPolicy } from '../../src/creation/types.js';
import {
  appendEvent,
  readEvents,
  sessionEndEvent,
  sessionEventsFile,
  sessionLifecycleEvent,
  summarizeSession,
} from '../../src/events/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir } from '../helpers.js';

const RECORDINGS = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings');
const execFileAsync = promisify(execFile);

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The answer a user who accepts every default would send. */
function defaultAnswer(state: CreationState): unknown {
  const pending = state.pending;
  if (pending === undefined) throw new Error('nothing pending');
  switch (pending.kind) {
    case 'question':
      return Object.fromEntries(pending.payload.questions.map((q) => [q.question, q.options[0]?.label ?? '']));
    case 'permission':
      return 'allow';
    case 'spec':
      return { decision: 'approve' };
    case 'grant':
      return true;
  }
}

describe('CreationManager', () => {
  let sessionsDir: string;
  let cleanup: () => Promise<void>;
  let manager: CreationManager | undefined;
  beforeEach(async () => {
    const temp = await tempDir('creation-manager');
    sessionsDir = path.join(temp.dir, 'sessions');
    cleanup = temp.cleanup;
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  const make = async (
    recording: string | CreationRunner,
    options: { policy?: PermissionPolicy; cancelTimeoutMs?: number } = {},
  ): Promise<CreationManager> => {
    const runner =
      typeof recording === 'string' ? await FakeRunner.fromFile(path.join(RECORDINGS, recording)) : recording;
    manager = new CreationManager({
      runner,
      sessionsDir,
      policy: () => options.policy ?? 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
      cancelTimeoutMs: options.cancelTimeoutMs ?? 5000,
    });
    return manager;
  };

  /** Answers every request with its default until the creation finishes. */
  const runToEnd = async (m: CreationManager, id: string, answer = defaultAnswer): Promise<CreationState> => {
    for (;;) {
      const state = await waitFor(() => {
        const s = m.get(id);
        return s.status === 'finished' || s.pending !== undefined ? s : undefined;
      });
      if (state.status === 'finished') return state;
      m.answer(id, state.pending?.id ?? '', answer(state));
    }
  };

  const fileEvents = async (state: CreationState) =>
    (await readEvents(sessionEventsFile(sessionsDir, state.sessionId ?? ''))).events;

  it('runs the full recording to completed and streams every step in order', async () => {
    const m = await make('full.jsonl');
    const { id } = await m.create('A garden planner');
    const seen: StreamEvent[] = [];
    let ended = false;
    m.subscribe(id, 0, (event) => seen.push(event), () => (ended = true));
    const final = await runToEnd(m, id);

    expect(final).toMatchObject({ status: 'finished', outcome: 'completed', idea: 'A garden planner', profile: 'balanced' });
    expect(final.pending).toBeUndefined();
    expect(final.finishedAt).toBeDefined();
    // The stream ends once the runner is done and the file was read a last time.
    await waitFor(() => ended);
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));
    const kinds = seen.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'question')).toHaveLength(4); // two batches, pending + answered
    expect(kinds.filter((k) => k === 'permission')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'spec')).toHaveLength(2);
    expect(seen.at(-1)).toMatchObject({ kind: 'status', data: { status: 'finished', outcome: 'completed' } });

    // Flow events arrive in file order, and the first question comes after `interview started`.
    const flow = seen.flatMap((e) => (e.kind === 'flow' && 'step' in e.data ? [`${e.data.step}:${e.data.type}`] : []));
    expect(flow[0]).toBe('idea:step.started');
    expect(flow.at(-1)).toBe('handoff:step.finished');
    const interview = seen.findIndex((e) => e.kind === 'flow' && 'step' in e.data && e.data.step === 'interview');
    const question = seen.findIndex((e) => e.kind === 'question');
    expect(question).toBeGreaterThan(interview);
    expect(seen.filter((e) => e.kind === 'hook').length).toBe((await fileEvents(final)).filter((e) => e.source === 'hook').length);
  });

  it('goes back to the architect on a change at the spec, then completes', async () => {
    const m = await make('change-at-spec.jsonl');
    const { id } = await m.create('A novel');
    let specs = 0;
    const final = await runToEnd(m, id, (state) => {
      if (state.pending?.kind !== 'spec') return defaultAnswer(state);
      specs += 1;
      return specs === 1 ? { decision: 'change', text: 'Make it a trilogy' } : { decision: 'approve' };
    });
    expect(specs).toBe(2);
    expect(final.outcome).toBe('completed');
    expect((await fileEvents(final)).filter((e) => e.type === 'subagent.start')).toHaveLength(2);
  });

  it('cancels with a question pending: answers it with cancel and the flow closes the session', async () => {
    const m = await make('full.jsonl');
    const { id } = await m.create('x');
    const pending = await waitFor(() => m.get(id).pending);
    expect(pending.kind).toBe('question');
    expect(m.cancel(id)).toMatchObject({ status: 'running', cancelling: true });
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    expect(final.outcome).toBe('cancelled');
    expect(final.cancelling).toBeUndefined();
    const events = await fileEvents(final);
    expect(events.at(-2)).toMatchObject({ type: 'step.finished', step: 'interview', outcome: 'skipped' });
    expect(summarizeSession(events)).toMatchObject({ status: 'finished', outcome: 'cancelled' });
    const answered: StreamEvent[] = [];
    m.subscribe(id, 0, (e) => answered.push(e));
    expect(answered.find((e) => e.kind === 'question' && e.data.state === 'answered')?.data).toMatchObject({
      answer: { decision: 'cancel' },
    });
  });

  it('cancels between steps at the next step boundary', async () => {
    const steps = parseRecording(
      [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"generate","phase":"started"}',
        '{"do":"wait","ms":60000}',
        '{"do":"flow","step":"generate","phase":"finished","outcome":"ok"}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    );
    const m = await make(new FakeRunner({ steps }));
    const { id } = await m.create('x');
    const seen: StreamEvent[] = [];
    m.subscribe(id, 0, (e) => seen.push(e));
    await waitFor(() => seen.some((e) => e.kind === 'flow' && 'step' in e.data));
    m.cancel(id);
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined), 2000);
    expect(final.outcome).toBe('cancelled');
    expect((await fileEvents(final)).at(-2)).toMatchObject({ step: 'generate', outcome: 'skipped' });
  });

  it('writes the close itself when the flow ignores the cancel', async () => {
    const steps = parseRecording(
      [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"generate","phase":"started"}',
        '{"do":"wait","ms":60000}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    );
    const m = await make(new FakeRunner({ steps, ignoreCancel: true }), { cancelTimeoutMs: 50 });
    const { id } = await m.create('x');
    const seen: StreamEvent[] = [];
    m.subscribe(id, 0, (e) => seen.push(e));
    await waitFor(() => seen.some((e) => e.kind === 'flow' && 'step' in e.data));
    m.cancel(id);
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined), 2000);
    expect(final.outcome).toBe('cancelled');
    const events = await fileEvents(final);
    expect(events.slice(-2)).toMatchObject([
      { type: 'step.finished', step: 'generate', outcome: 'skipped' },
      { type: 'session.finished', outcome: 'cancelled' },
    ]);
  });

  it('marks a turn that ended with nothing asked as awaiting a reply, redacted, until the next turn or request', async () => {
    const key = ['sk', 'ant', 'a'.repeat(30)].join('-');
    const steps = parseRecording(
      [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"spec","phase":"started"}',
        JSON.stringify({ do: 'emit', event: { kind: 'status', status: 'turnEnded', message: `Do you approve it?\nkey=${key}` } }),
        '{"do":"wait","ms":150}',
        '{"do":"emit","event":{"kind":"status","status":"running"}}',
        '{"do":"wait","ms":150}',
        '{"do":"emit","event":{"kind":"status","status":"turnEnded","message":"Again?"}}',
        '{"do":"question","questions":[{"question":"Name?","header":"Name","options":[{"label":"A","description":""}],"multiSelect":false}]}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    );
    const m = await make(new FakeRunner({ steps }));
    const { id } = await m.create('x');
    const seen: StreamEvent[] = [];
    m.subscribe(id, 0, (e) => seen.push(e));

    const waiting = await waitFor(() => m.get(id).awaitingReply);
    expect(waiting.lastMessage).toContain('Do you approve it?');
    expect(waiting.lastMessage).not.toContain(key);
    expect(JSON.stringify(seen)).not.toContain(key);
    await waitFor(() => m.get(id).awaitingReply === undefined);

    // A question asked after the end of a turn is what the page shows instead.
    const asked = await waitFor(() => (m.get(id).pending !== undefined ? m.get(id) : undefined));
    expect(asked.awaitingReply).toBeUndefined();
    const final = await runToEnd(m, id);
    expect(final.awaitingReply).toBeUndefined();
  });

  it('allows two active creations by default, and refuses a third, even when started together', async () => {
    const m = await make('full.jsonl');
    const [first, second] = await Promise.all([m.create('one'), m.create('two')]);
    await expect(m.create('three')).rejects.toMatchObject({ code: 'creation.limit', params: { limit: 2, active: [first.id, second.id] } });
    await runToEnd(m, first.id);
    const third = await m.create('three');
    expect(third.id).not.toBe(first.id);
    expect(m.list().filter((c) => c.status !== 'finished').map((c) => c.idea)).toEqual(['two', 'three']);
  });

  it('waits to start a creation while an improvement is applied or reverted, and holders take turns', async () => {
    const m = await make('full.jsonl');
    let release!: () => void;
    const order: string[] = [];
    const first = m.holdStarts(async () => {
      order.push('first in');
      await new Promise<void>((resolve) => (release = resolve));
      // No creation registered while the hold lasts.
      order.push(`first out, ${m.list().length} creations`);
    });
    const second = m.holdStarts(async () => {
      order.push('second in');
    });
    const started = m.create('one').then((state) => {
      order.push('created');
      return state;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.list()).toEqual([]);
    expect(order).toEqual(['first in']);
    release();
    await Promise.all([first, second, started]);
    expect(order).toEqual(['first in', 'first out, 0 creations', 'second in', 'created']);
    await runToEnd(m, (await started).id);
  });

  it('reads the limit at each start', async () => {
    let limit = 1;
    manager = new CreationManager({
      runner: await FakeRunner.fromFile(path.join(RECORDINGS, 'full.jsonl')),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus' }),
      maxActive: () => limit,
      pollMs: 10,
      tailMs: 20,
    });
    const m = manager;
    await m.create('one');
    await expect(m.create('two')).rejects.toMatchObject({ code: 'creation.limit', params: { limit: 1 } });
    limit = 3;
    await m.create('two');
    await m.create('three');
    await expect(m.create('four')).rejects.toMatchObject({ code: 'creation.limit', params: { limit: 3 } });
    expect(m.list().map((c) => c.idea)).toEqual(['one', 'two', 'three']);
  });

  it('denies permission requests under the unattended policy and lists them in the final state', async () => {
    const m = await make('full.jsonl', { policy: 'unattended' });
    const { id } = await m.create('x');
    const kinds: string[] = [];
    m.subscribe(id, 0, (e) => kinds.push(e.kind));
    const final = await runToEnd(m, id);
    expect(final.outcome).toBe('completed');
    expect(final.policy).toBe('unattended');
    expect(final.denied).toEqual([{ toolName: 'Bash', summary: 'git status', agentType: 'generator', at: expect.any(String) }]);
    expect(kinds).toContain('denied');
    expect(kinds).not.toContain('permission');
  });

  it('replays exactly the missed events to a subscriber that reconnects', async () => {
    const m = await make('full.jsonl');
    const { id } = await m.create('x');
    const all: StreamEvent[] = [];
    m.subscribe(id, 0, (e) => all.push(e));

    // A first tab sees everything up to the first question, then closes.
    const before: StreamEvent[] = [];
    const first = await waitFor(() => m.get(id).pending);
    const unsubscribe = m.subscribe(id, 0, (e) => before.push(e));
    unsubscribe();
    const lastSeen = before.at(-1)?.seq ?? 0;
    m.answer(id, first.id, defaultAnswer(m.get(id)));

    // While it is closed the flow moves on to the next question.
    await waitFor(() => (m.get(id).pending?.id === 'p2' ? true : undefined));
    const after: StreamEvent[] = [];
    let ended = false;
    m.subscribe(id, lastSeen, (e) => after.push(e), () => (ended = true));
    expect(after[0]?.seq).toBe(lastSeen + 1);
    await runToEnd(m, id);
    // The stream ends once the runner is done and the file was read a last time.
    await waitFor(() => ended);
    expect([...before, ...after]).toEqual(all);
  });

  it('marks the session interrupted on server stop', async () => {
    const m = await make('full.jsonl');
    const { id } = await m.create('x');
    await waitFor(() => m.get(id).pending);
    await m.shutdown();
    const final = m.get(id);
    expect(final).toMatchObject({ status: 'finished', outcome: 'interrupted' });
    const events = await fileEvents(final);
    expect(events.at(-1)).toMatchObject({ source: 'hook', type: 'session.end', reason: 'server_stop' });
    expect(summarizeSession(events)).toMatchObject({ status: 'interrupted', endReason: 'server_stop' });
  });

  it('returns from shutdown within its limit when a runner never stops, and closes what is left', async () => {
    const runner: CreationRunner = {
      start: () => ({
        sessionId: Promise.resolve('never-stops'),
        requestCancel: () => undefined,
        sendMessage: () => undefined,
        stop: () => new Promise<void>(() => undefined),
        done: new Promise(() => undefined),
      }),
    };
    const m = new CreationManager({ runner, sessionsDir, policy: () => 'ask', profile: () => ({ name: 'saver', sessionModel: 'sonnet' }), shutdownTimeoutMs: 200 });
    const { id } = await m.create('x');
    let ended = false;
    m.subscribe(id, 0, () => undefined, () => (ended = true));
    const started = Date.now();
    await m.shutdown();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(m.get(id)).toMatchObject({ status: 'finished', outcome: 'interrupted' });
    expect(ended).toBe(true);
  });

  it('finishes a top-level shutdown in a process that nothing else keeps alive', async () => {
    const fixture = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'shutdown-alone.ts');
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', fixture, sessionsDir], { cwd: PACKAGE_ROOT, timeout: 30_000 });
    expect(stdout).toContain('shutdown returned: interrupted');
  }, 40_000);

  it('streams the session.end Claude Code writes as it exits, after session.finished', async () => {
    const session = 'late-end';
    const runner: CreationRunner = {
      start: (options) => {
        const done = (async () => {
          await appendEvent(options.sessionsDir, sessionLifecycleEvent(session, 'started', undefined, new Date()));
          await appendEvent(options.sessionsDir, sessionLifecycleEvent(session, 'finished', 'completed', new Date()));
          // The manager sees `session.finished` and finishes before this line exists.
          await new Promise((resolve) => setTimeout(resolve, 150));
          await appendEvent(options.sessionsDir, sessionEndEvent(session, 'other', new Date()));
          return { kind: 'ended' as const };
        })();
        return { sessionId: Promise.resolve(session), requestCancel: () => undefined, sendMessage: () => undefined, stop: async () => undefined, done };
      },
    };
    const m = await make(runner);
    const { id } = await m.create('x');
    const seen: StreamEvent[] = [];
    let ended = false;
    m.subscribe(id, 0, (event) => seen.push(event), () => (ended = true));
    await waitFor(() => (m.get(id).status === 'finished' ? true : undefined));
    await waitFor(() => ended);
    const finishedAt = seen.findIndex((e) => e.kind === 'status' && e.data.status === 'finished');
    const end = seen.findIndex((e) => e.kind === 'hook' && e.data.type === 'session.end');
    expect(finishedAt).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(finishedAt);
    // A tab opened afterwards gets the same lines, once each.
    const replay: StreamEvent[] = [];
    m.subscribe(id, 0, (event) => replay.push(event));
    expect(replay).toEqual(seen);
  });

  it('sends a free-text reply only while the session waits for one, and the flow goes on', async () => {
    const received: string[] = [];
    const steps = parseRecording(
      [
        '{"do":"session","phase":"started"}',
        '{"do":"turnEnd","message":"Which name?"}',
        '{"do":"question","questions":[{"question":"Next?","header":"","options":[{"label":"Yes","description":""},{"label":"No","description":""}],"multiSelect":false}]}',
        '{"do":"session","phase":"finished"}',
      ].join('\n'),
    );
    const m = await make(new FakeRunner({ steps, received }));
    const { id } = await m.create('x');
    await waitFor(() => m.get(id).awaitingReply);
    expect(m.get(id).awaitingReply?.lastMessage).toBe('Which name?');
    const state = m.reply(id, 'Seedling');
    expect(state.awaitingReply).toBeUndefined();
    const pending = await waitFor(() => m.get(id).pending);
    expect(received).toEqual(['Seedling']);
    // Not while something is asked, nor once finished.
    expect(() => m.reply(id, 'again')).toThrow(expect.objectContaining({ code: 'creation.noReply' }));
    m.answer(id, pending.id, { 'Next?': 'Yes' });
    await waitFor(() => (m.get(id).status === 'finished' ? true : undefined));
    expect(() => m.reply(id, 'late')).toThrow(expect.objectContaining({ code: 'creation.noReply' }));
    expect(received).toEqual(['Seedling']);
  });

  it('counts turns that ended in text and tells observers when a creation starts and finishes', async () => {
    const steps = parseRecording(
      ['{"do":"session","phase":"started"}', '{"do":"turnEnd","message":"Which name?"}', '{"do":"session","phase":"finished"}'].join('\n'),
    );
    const m = await make(new FakeRunner({ steps }));
    const told: string[] = [];
    const off = m.observe({
      started: (state) => told.push(`started ${state.idea}`),
      finished: (state) => told.push(`finished ${state.outcome ?? ''} ${state.textTurns ?? 0}`),
    });
    m.observe({
      started: () => {
        throw new Error('an observer that fails changes nothing');
      },
    });
    const { id } = await m.create('x');
    await waitFor(() => m.get(id).awaitingReply);
    expect(m.get(id).textTurns).toBe(1);
    m.reply(id, 'Seedling');
    await waitFor(() => (m.get(id).status === 'finished' ? true : undefined));
    expect(told).toEqual(['started x', 'finished completed 1']);
    off();
  });

  it('never waits for a reply once finished: the flow closes the session before its last text', async () => {
    const session = 'late-turn-end';
    let release: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => (release = resolve));
    const runner: CreationRunner = {
      start: (options) => {
        const done = (async () => {
          await appendEvent(options.sessionsDir, sessionLifecycleEvent(session, 'started', undefined, new Date()));
          await appendEvent(options.sessionsDir, sessionLifecycleEvent(session, 'finished', 'completed', new Date()));
          // The hand-off text comes after the close: the manager has finished by then.
          await closed;
          options.io.emit({ kind: 'status', status: 'turnEnded', message: 'Your project is ready.' });
          return { kind: 'ended' as const };
        })();
        return { sessionId: Promise.resolve(session), requestCancel: () => undefined, sendMessage: () => undefined, stop: async () => undefined, done };
      },
    };
    const m = await make(runner);
    const { id } = await m.create('x');
    const seen: StreamEvent[] = [];
    m.subscribe(id, 0, (event) => seen.push(event));
    await waitFor(() => (m.get(id).status === 'finished' ? true : undefined));
    release();
    // The late turn end still reaches the stream, but the state asks for nothing.
    await waitFor(() => seen.some((e) => e.kind === 'status' && e.data.runner?.kind === 'status' && e.data.runner.status === 'turnEnded'));
    expect(m.get(id).awaitingReply).toBeUndefined();
    expect(() => m.reply(id, 'Go on')).toThrow(expect.objectContaining({ code: 'creation.noReply' }));
  });

  it('never waits for a reply while cancelling', async () => {
    const steps = parseRecording(
      [
        '{"do":"session","phase":"started"}',
        '{"do":"turnEnd","message":"Which name?"}',
        '{"do":"emit","event":{"kind":"status","status":"turnEnded","message":"Stopping."}}',
        '{"do":"wait","ms":50}',
        '{"do":"session","phase":"finished","outcome":"cancelled"}',
      ].join('\n'),
    );
    const m = await make(new FakeRunner({ steps }));
    const { id } = await m.create('x');
    await waitFor(() => m.get(id).awaitingReply);
    const cancelling = m.cancel(id);
    expect(cancelling.awaitingReply).toBeUndefined();
    await waitFor(() => (m.get(id).status === 'finished' ? true : undefined));
    expect(m.get(id).awaitingReply).toBeUndefined();
  });

  it('marks the session interrupted when the runner ends without closing it', async () => {
    const steps = parseRecording('{"do":"session","phase":"started"}\n{"do":"exit"}');
    const m = await make(new FakeRunner({ steps }));
    const { id } = await m.create('x');
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    expect(final.outcome).toBe('interrupted');
    expect(summarizeSession(await fileEvents(final))).toMatchObject({ status: 'interrupted', endReason: 'runner_exit' });
  });

  it('checks every answer against what is pending', async () => {
    const m = await make('full.jsonl');
    const { id } = await m.create('x');
    expect(() => m.get('nope')).toThrow(expect.objectContaining({ code: 'creation.notFound' }));
    const pending = await waitFor(() => m.get(id).pending);
    expect(() => m.answer(id, 'p9', {})).toThrow(expect.objectContaining({ code: 'creation.wrongPending' }));
    expect(() => m.answer(id, pending.id, 'allow')).toThrow(expect.objectContaining({ code: 'creation.invalidAnswer' }));
    expect(() => m.answer(id, pending.id, { 'Who is the planner for?': 'Me' })).toThrow(
      expect.objectContaining({ code: 'creation.invalidAnswer', params: expect.objectContaining({ issues: ['missing: Where should the project be created?'] }) }),
    );
    expect(() =>
      m.answer(id, pending.id, { 'Who is the planner for?': 'Me', 'Where should the project be created?': 'x', Other: 'y' }),
    ).toThrow(expect.objectContaining({ code: 'creation.invalidAnswer' }));
    const state = m.answer(id, pending.id, { 'Who is the planner for?': 'Me', 'Where should the project be created?': 'here' });
    expect(state.pending?.id).not.toBe(pending.id);
    await m.shutdown();
    expect(() => m.answer(id, 'p2', {})).toThrow(expect.objectContaining({ code: 'creation.noPending' }));
  });
});

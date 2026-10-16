import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager, type CreationState, type StreamEvent } from '../../src/creation/manager.js';
import type { PermissionPolicy } from '../../src/creation/types.js';
import { readEvents, sessionEventsFile, summarizeSession } from '../../src/events/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir } from '../helpers.js';

const RECORDINGS = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings');

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
    recording: string | FakeRunner,
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
    expect(ended).toBe(true);
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

  it('allows one active creation at a time', async () => {
    const m = await make('full.jsonl');
    const first = await m.create('one');
    await expect(m.create('two')).rejects.toMatchObject({ code: 'creation.busy', params: { active: first.id } });
    await runToEnd(m, first.id);
    const second = await m.create('two');
    expect(second.id).not.toBe(first.id);
    expect(m.list().map((c) => c.id)).toEqual([first.id, second.id]);
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
    expect(ended).toBe(true);
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

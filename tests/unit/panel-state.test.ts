import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOW_STEPS, STALE_AFTER_MINUTES, summarizeSession, type SessionEvent } from '../../src/events/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { OUTSIDE_TEXT, hideAbsolutePaths, projectEvent, projectReason, projectTarget } from '../../src/panel/project.js';
import { PANEL_STALE_AFTER_MINUTES, PANEL_STEPS, buildPanelState, type PanelEventInput } from '../../src/panel/state.js';

const FIXTURE = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'sessions', 'h10-run3.jsonl');
const KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

const T0 = Date.UTC(2026, 9, 16, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** A tiny builder for lines. */
const flow = (s: number, type: string, extra: Partial<PanelEventInput> = {}): PanelEventInput => ({ ts: at(s), source: 'flow', type, ...extra });
const hook = (s: number, type: string, extra: Partial<PanelEventInput> = {}): PanelEventInput => ({ ts: at(s), source: 'hook', type, ...extra });
const runner = (s: number, type: string, extra: Partial<PanelEventInput> = {}): PanelEventInput => ({ ts: at(s), source: 'runner', type, ...extra });

describe('buildPanelState', () => {
  it('keeps its constants equal to the events module', () => {
    expect(PANEL_STEPS).toEqual(FLOW_STEPS);
    expect(PANEL_STALE_AFTER_MINUTES).toBe(STALE_AFTER_MINUTES);
  });

  it('shows a running creation: agents in start order, the tool each uses now, model and effort', () => {
    const events = [
      flow(0, 'session.started'),
      runner(0, 'session.profile', { profile: 'balanced', model: 'opus', effort: 'medium' }),
      runner(1, 'usage', { fiveHour: 10, sevenDay: 40 }),
      flow(1, 'step.started', { step: 'idea' }),
      flow(2, 'step.finished', { step: 'idea', outcome: 'ok' }),
      flow(3, 'step.started', { step: 'gap-analysis' }),
      hook(4, 'tool.pre', { tool: 'Agent', toolUseId: 'm1', effort: 'high' }),
      hook(5, 'subagent.start', { agentId: 'i1', agentType: 'interviewer', model: 'sonnet' }),
      hook(6, 'tool.pre', { agentId: 'i1', agentType: 'interviewer', tool: 'Read', toolUseId: 'r1', target: { root: 'repo', path: 'library/rules/target.md' }, effort: 'medium' }),
      hook(7, 'tool.pre', { agentId: 'i1', agentType: 'interviewer', tool: 'Read', toolUseId: 'r2', target: { root: 'repo', path: 'schemas/spec.schema.json' } }),
      // Parallel calls end in another order: paired by id.
      hook(8, 'tool.post', { agentId: 'i1', agentType: 'interviewer', tool: 'Read', toolUseId: 'r2' }),
      runner(9, 'usage', { fiveHour: 12, sevenDay: 41 }),
    ];
    const state = buildPanelState(events, { now: new Date(T0 + 10_000) });
    expect(state.session).toEqual({ status: 'running', startedAt: at(0), profile: 'balanced' });
    expect(state.nodes.map((node) => [node.id, node.agentType, node.status])).toEqual([
      ['main', 'main', 'running'],
      ['i1', 'interviewer', 'running'],
    ]);
    const [main, interviewer] = state.nodes;
    expect(main).toMatchObject({ model: 'opus', effort: 'high', toolCalls: 1, current: { tool: 'Agent' }, durationMs: 10_000 });
    expect(interviewer).toMatchObject({
      model: 'sonnet',
      effort: 'medium',
      toolCalls: 2,
      current: { tool: 'Read', target: { root: 'repo', path: 'library/rules/target.md' }, since: at(6) },
      startedAt: at(5),
      durationMs: 5000,
    });
    expect(state.steps.slice(0, 3)).toEqual([
      { step: 'idea', state: 'ok' },
      { step: 'gap-analysis', state: 'running' },
      { step: 'interview', state: 'waiting' },
    ]);
    expect(state.usage).toEqual({ start: { at: at(1), fiveHour: 10, sevenDay: 40 }, now: { at: at(9), fiveHour: 12, sevenDay: 41 } });
    expect(state.timeline.rows).toEqual([
      { nodeId: 'main', startMs: 0, endMs: 10_000, open: true },
      { nodeId: 'i1', startMs: 5000, endMs: 10_000, open: true },
    ]);
    expect(state.timeline.spanMs).toBe(10_000);
  });

  it('puts a pending request on the node that asked', () => {
    const events = [
      flow(0, 'session.started'),
      hook(1, 'subagent.start', { agentId: 'g1', agentType: 'generator' }),
      hook(2, 'tool.pre', { agentId: 'g1', agentType: 'generator', tool: 'Bash', toolUseId: 'b1' }),
    ];
    const permission = buildPanelState(events, {
      now: new Date(T0 + 3000),
      live: { finished: false, pending: { id: 'p1', kind: 'permission', agentType: 'generator' } },
    });
    expect(permission.nodes[1]).toMatchObject({ status: 'waiting', pending: { id: 'p1', kind: 'permission' }, current: { tool: 'Bash' } });
    expect(permission.nodes[0]?.pending).toBeUndefined();

    const question = buildPanelState(events, { now: new Date(T0 + 3000), live: { finished: false, pending: { id: 'p2', kind: 'question' } } });
    expect(question.nodes[0]).toMatchObject({ status: 'waiting', pending: { id: 'p2', kind: 'question' } });
    expect(question.nodes[1]?.status).toBe('running');

    // A permission from an agent type that is not running goes to the main session.
    const orphan = buildPanelState(events, {
      now: new Date(T0 + 3000),
      live: { finished: false, pending: { id: 'p3', kind: 'permission', agentType: 'reviewer' } },
    });
    expect(orphan.nodes[0]?.pending?.id).toBe('p3');
  });

  it('shows denials on the node that caused them, with the reason and the target of the call', () => {
    const events = [
      flow(0, 'session.started'),
      hook(1, 'subagent.start', { agentId: 'a1', agentType: 'architect' }),
      hook(2, 'tool.pre', { agentId: 'a1', agentType: 'architect', tool: 'Write', toolUseId: 'w1', target: { root: 'outside' } }),
      runner(2, 'tool.denied', { agentId: 'a1', agentType: 'architect', tool: 'Write', toolUseId: 'w1', by: 'guard', reason: 'Writes only inside.' }),
      hook(3, 'tool.pre', { tool: 'Bash', toolUseId: 'b1' }),
      runner(4, 'tool.denied', { tool: 'Bash', by: 'user' }),
      // A policy denial that names only the agent type.
      hook(5, 'tool.pre', { agentId: 'a1', agentType: 'architect', tool: 'Bash' }),
      runner(5, 'tool.denied', { agentType: 'architect', tool: 'Bash', by: 'policy' }),
    ];
    const state = buildPanelState(events, { now: new Date(T0 + 6000) });
    const [main, architect] = state.nodes;
    expect(architect?.denials).toEqual([
      { at: at(2), tool: 'Write', by: 'guard', reason: 'Writes only inside.', target: { root: 'outside' } },
      { at: at(5), tool: 'Bash', by: 'policy' },
    ]);
    expect(architect?.current).toBeUndefined();
    expect(architect?.toolCalls).toBe(2);
    expect(main?.denials).toEqual([{ at: at(4), tool: 'Bash', by: 'user' }]);
    expect(main?.current).toBeUndefined();
  });

  it('reopens an agent that works after its stop, and ends it at its last stop', () => {
    const events = [
      flow(0, 'session.started'),
      hook(1, 'subagent.start', { agentId: 'r1', agentType: 'researcher' }),
      hook(2, 'subagent.stop', { agentId: 'r1', agentType: 'researcher' }),
      hook(3, 'tool.pre', { agentId: 'r1', agentType: 'researcher', tool: 'SubagentHandback' }),
    ];
    const middle = buildPanelState(events, { now: new Date(T0 + 4000) });
    expect(middle.nodes[1]).toMatchObject({ status: 'running', current: { tool: 'SubagentHandback' } });
    expect(middle.nodes[1]?.endedAt).toBeUndefined();
    const done = buildPanelState(
      [...events, hook(4, 'tool.post', { agentId: 'r1', agentType: 'researcher', tool: 'SubagentHandback' }), hook(5, 'subagent.stop', { agentId: 'r1', agentType: 'researcher' })],
      { now: new Date(T0 + 6000) },
    );
    expect(done.nodes[1]).toMatchObject({ status: 'done', endedAt: at(5), durationMs: 4000 });
    expect(done.nodes[1]?.current).toBeUndefined();
  });

  it.each([
    ['completed', 'done'],
    ['cancelled', 'cancelled'],
    ['failed', 'failed'],
  ])('ends the main session as %s, and an agent that never stopped as no end recorded', (outcome, mainStatus) => {
    const events = [
      flow(0, 'session.started'),
      hook(1, 'subagent.start', { agentId: 'g1', agentType: 'generator' }),
      hook(2, 'tool.pre', { agentId: 'g1', agentType: 'generator', tool: 'Write' }),
      flow(3, 'session.finished', { outcome }),
    ];
    const state = buildPanelState(events, { now: new Date(T0 + 3_600_000) });
    expect(state.session).toMatchObject({ status: 'finished', outcome, endedAt: at(3) });
    expect(state.nodes.map((node) => node.status)).toEqual([mainStatus, 'noEnd']);
    expect(state.nodes[1]?.current).toBeUndefined();
    expect(state.nodes[1]?.durationMs).toBe(2000);
    expect(state.timeline.rows.every((row) => !row.open)).toBe(true);
    expect(state.timeline.rows[1]).toMatchObject({ startMs: 1000, endMs: 3000 });
  });

  it('reads an interrupted session the way the session list does', () => {
    const cases: SessionEvent[][] = [
      [
        { v: 1, ts: at(0), session: 's', source: 'flow', type: 'session.started' },
        { v: 1, ts: at(5), session: 's', source: 'hook', type: 'session.end', reason: 'server_stop' },
        { v: 1, ts: at(6), session: 's', source: 'runner', type: 'usage', fiveHour: 1, sevenDay: 1 },
      ],
      [{ v: 1, ts: at(0), session: 's', source: 'flow', type: 'session.started' }],
      [
        { v: 1, ts: at(0), session: 's', source: 'flow', type: 'session.started' },
        { v: 1, ts: at(5), session: 's', source: 'hook', type: 'session.end', reason: 'other' },
        { v: 1, ts: at(6), session: 's', source: 'hook', type: 'tool.pre', tool: 'Read' },
      ],
    ];
    for (const minutes of [1, 500]) {
      const now = new Date(T0 + minutes * 60_000);
      for (const events of cases) {
        const summary = summarizeSession(events, { now });
        const state = buildPanelState(events as unknown as PanelEventInput[], { now });
        expect(state.session.status, `${minutes} ${JSON.stringify(events.at(-1))}`).toBe(summary.status === 'in-progress' ? 'running' : summary.status);
      }
    }
    const state = buildPanelState(cases[0] as unknown as PanelEventInput[], { now: new Date(T0 + 60_000) });
    expect(state.nodes[0]).toMatchObject({ status: 'interrupted', endedAt: at(5) });
  });

  it('trusts the live state of an open creation over the clock', () => {
    const events = [flow(0, 'session.started')];
    const late = new Date(T0 + 10 * 3_600_000);
    expect(buildPanelState(events, { now: late, live: { finished: false } }).session.status).toBe('running');
    expect(buildPanelState(events, { now: late, live: { finished: true, outcome: 'interrupted' } }).session.status).toBe('interrupted');
    expect(buildPanelState(events, { now: late, live: { finished: true, outcome: 'cancelled' } }).session).toMatchObject({ status: 'finished', outcome: 'cancelled' });
  });

  it('copes with nothing, odd lines and a burst', () => {
    expect(buildPanelState([], { now: new Date(T0) })).toMatchObject({ session: { status: 'interrupted' }, nodes: [{ id: 'main' }], eventCount: 0 });
    const odd = buildPanelState(
      [{ ts: 'not a time', source: 'hook', type: 'tool.post', tool: 'Read' }, { ts: at(1), source: 'other', type: 'x' }, hook(2, 'subagent.stop', { agentType: 'ghost' })],
      { now: new Date(T0 + 3000), live: { finished: false } },
    );
    expect(odd.nodes).toHaveLength(1);

    const burst: PanelEventInput[] = [flow(0, 'session.started'), hook(0, 'subagent.start', { agentId: 'r1', agentType: 'reviewer' })];
    for (let index = 0; index < 20_000; index += 1) {
      burst.push(hook(1, 'tool.pre', { agentId: 'r1', agentType: 'reviewer', tool: 'Read', toolUseId: `t${index}` }));
      burst.push(hook(1, 'tool.post', { agentId: 'r1', agentType: 'reviewer', tool: 'Read', toolUseId: `t${index}` }));
    }
    const started = performance.now();
    const state = buildPanelState(burst, { now: new Date(T0 + 2000) });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(state.nodes[1]).toMatchObject({ toolCalls: 20_000 });
    expect(state.nodes[1]?.current).toBeUndefined();
  });
});

describe('the real H10 run 3 session (placeholders for ids)', () => {
  const load = async () =>
    (await readFile(FIXTURE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);

  it('holds no personal path, name or real id', async () => {
    const text = await readFile(FIXTURE, 'utf8');
    for (const event of await load()) {
      expect(event.session).toBe('h10-run3-session');
      if ('agentId' in event && event.agentId !== undefined) expect(event.agentId).toMatch(/^agent-\d+$/);
    }
    expect(text).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\/home\/|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('rebuilds the whole run: six agents in order, every step ok, nothing open, no denials', async () => {
    const events = (await load()).map((event, index) => projectEvent(event, index + 1));
    const state = buildPanelState(events, { now: new Date('2026-10-17T00:00:00Z') });
    expect(state.session).toMatchObject({ status: 'finished', outcome: 'completed', startedAt: '2026-10-16T11:37:00.585Z' });
    expect(state.nodes.map((node) => node.agentType)).toEqual(['main', 'interviewer', 'interviewer', 'researcher', 'architect', 'generator', 'reviewer']);
    expect(state.nodes.map((node) => node.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done']);
    expect(state.steps.every((step) => step.state === 'ok')).toBe(true);
    expect(state.nodes.every((node) => node.current === undefined && node.denials.length === 0)).toBe(true);
    // Recorded before phase 3: no model, effort or target, and the panel still renders.
    expect(state.nodes.every((node) => node.model === undefined && node.effort === undefined)).toBe(true);
    const calls = Object.fromEntries(state.nodes.map((node) => [node.id, node.toolCalls]));
    expect(calls).toEqual({ main: 52, 'agent-1': 1, 'agent-2': 1, 'agent-3': 31, 'agent-4': 9, 'agent-5': 18, 'agent-6': 13 });
    // The researcher stopped twice; it ends at its last stop.
    expect(state.nodes[3]).toMatchObject({ endedAt: '2026-10-16T11:39:55.663Z' });
    expect(state.usage).toEqual({});
    expect(state.timeline.rows).toHaveLength(7);
    expect(state.timeline.rows.every((row) => !row.open && row.endMs >= row.startMs)).toBe(true);
  });
});

describe('projection for the panel', () => {
  it('keeps known fields only, and the line id', () => {
    const projected = projectEvent(
      { v: 1, ts: at(0), session: 's', source: 'hook', type: 'tool.pre', tool: 'Read', toolUseId: 't1', extra: 'x' } as unknown as SessionEvent,
      7,
    );
    expect(projected).toEqual({ id: 7, v: 1, ts: at(0), session: 's', source: 'hook', type: 'tool.pre', tool: 'Read', toolUseId: 't1' });
  });

  it('redacts targets, refuses absolute ones and unknown roots', () => {
    expect(projectTarget({ root: 'projects', path: 'garden/docs/BRIEF.md' })).toEqual({ root: 'projects', path: 'garden/docs/BRIEF.md' });
    expect(projectTarget({ root: 'outside', path: 'C:/Users/someone/x.md' })).toEqual({ root: 'outside' });
    expect(projectTarget({ root: 'projects', path: 'C:/Users/someone/x.md' })).toEqual({ root: 'outside' });
    expect(projectTarget({ root: 'repo', path: '/home/someone/x' })).toEqual({ root: 'outside' });
    expect(projectTarget({ root: 'session', path: `notes/${KEY}.md` })?.path).not.toContain(KEY);
    expect(projectTarget({ root: 'elsewhere', path: 'x' })).toBeUndefined();
    expect(projectTarget('x')).toBeUndefined();
    expect(projectTarget({ root: 'cli', path: 'x'.repeat(300) })?.path?.length).toBe(120);
  });

  it('redacts reasons and hides any absolute path in them', () => {
    expect(projectReason(`Denied.\nkey=${KEY}`)).not.toContain(KEY);
    const reason = projectReason('Writes only inside C:\\Users\\someone\\projects and /home/someone/x.');
    expect(reason).not.toContain('someone');
    expect(reason).toContain(OUTSIDE_TEXT);
    expect(hideAbsolutePaths('Use "C:/Users/you/projects/app" with /add-dir')).toContain('/add-dir');
    expect(projectReason('x'.repeat(1000))?.length).toBe(300);
    expect(projectReason('')).toBeUndefined();
  });

  it('applies to runner lines: denial reasons redacted', () => {
    const projected = projectEvent(
      { v: 1, ts: at(0), session: 's', source: 'runner', type: 'tool.denied', tool: 'Write', by: 'guard', reason: `See D:\\private\\x.md ${KEY}` },
      1,
    );
    expect(JSON.stringify(projected)).not.toContain(KEY);
    expect(JSON.stringify(projected)).not.toContain('private');
  });
});

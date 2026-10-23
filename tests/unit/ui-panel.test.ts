import { describe, expect, it } from 'vitest';
import {
  barGeometry,
  formatClockDuration,
  nodeLabels,
  stepLooks,
  formatDuration,
  liveFromState,
  panelEventsFromStream,
  percent,
  stepNumber,
  targetText,
  timelineTicks,
  usageMeter,
} from '../../src/ui/panelData.js';
import { parseRoute, routeHash } from '../../src/ui/route.js';
import { resolveTheme } from '../../src/ui/themeChoice.js';
import type { CreationState, StreamEvent } from '../../src/ui/types.js';

const labels = { outside: 'outside allowed folders', root: (root: string) => `<${root}>` };

describe('panel data for the page', () => {
  it('takes the events.jsonl lines from the stream once each, in order', () => {
    const stream = [
      { seq: 1, ts: 't1', kind: 'status', data: { status: 'running' } },
      { seq: 2, ts: 't2', kind: 'flow', data: { ts: 'f2', type: 'session.started' } },
      { seq: 3, ts: 't3', kind: 'hook', data: { ts: 'h3', type: 'tool.pre', tool: 'Read' } },
      { seq: 3, ts: 't3', kind: 'hook', data: { ts: 'h3', type: 'tool.pre', tool: 'Read' } },
      { seq: 4, ts: 't4', kind: 'runner', data: { ts: 'r4', type: 'usage', fiveHour: 1, sevenDay: 2 } },
      { seq: 5, ts: 't5', kind: 'denied', data: { toolName: 'x', summary: '', at: 't5', by: 'policy' } },
    ] as unknown as StreamEvent[];
    expect(panelEventsFromStream(stream)).toEqual([
      { ts: 'f2', source: 'flow', type: 'session.started' },
      { ts: 'h3', source: 'hook', type: 'tool.pre', tool: 'Read' },
      { ts: 'r4', source: 'runner', type: 'usage', fiveHour: 1, sevenDay: 2 },
    ]);
  });

  it('says who is asked what, live', () => {
    const base = { id: 'c', idea: 'x', profile: 'balanced', policy: 'ask', denied: [], startedAt: 't' } as const;
    const permission = {
      ...base,
      status: 'waiting',
      pending: { id: 'p1', kind: 'permission', payload: { toolName: 'Bash', summary: 'x', agentType: 'generator' } },
    } as unknown as CreationState;
    expect(liveFromState(permission)).toEqual({ finished: false, pending: { id: 'p1', kind: 'permission', agentType: 'generator' } });
    const question = { ...base, status: 'waiting', pending: { id: 'p2', kind: 'question', payload: { questions: [] } } } as unknown as CreationState;
    expect(liveFromState(question)).toEqual({ finished: false, pending: { id: 'p2', kind: 'question' } });
    const done = { ...base, status: 'finished', outcome: 'cancelled' } as unknown as CreationState;
    expect(liveFromState(done)).toEqual({ finished: true, outcome: 'cancelled' });
  });

  it('formats durations, percents and targets', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(40)).toBe('< 0.1 s');
    expect(formatDuration(0)).toBe('< 0.1 s');
    expect(formatDuration(480)).toBe('0.4 s');
    expect(formatDuration(2_390, 'es')).toBe('2,3 s');
    expect(formatDuration(9_990)).toBe('9.9 s');
    expect(formatDuration(10_000)).toBe('10 s');
    expect(formatDuration(45_500)).toBe('45 s');
    expect(formatDuration(185_000)).toBe('3 min 5 s');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
    expect(percent(12.6)).toBe('13%');
    expect(percent(null)).toBe('?');
    expect(targetText(undefined, labels)).toBeUndefined();
    expect(targetText({ root: 'outside', path: 'should-not-show' }, labels)).toBe('outside allowed folders');
    expect(targetText({ root: 'cli', path: 'library add' }, labels)).toBe('briefstack library add');
    expect(targetText({ root: 'projects', path: 'garden/a.md' }, labels)).toBe('<projects>: garden/a.md');
    expect(targetText({ root: 'session' }, labels)).toBe('<session>');
  });

  it('routes to a session panel and back', () => {
    expect(parseRoute('#/sessions/abc-1')).toEqual({ page: 'session', id: 'abc-1' });
    expect(parseRoute('#/sessions')).toEqual({ page: 'projects' });
    expect(routeHash({ page: 'session', id: 'a b' })).toBe('#/sessions/a%20b');
  });
});

describe('the bs.css panel (U5)', () => {
  it('turns two plan readings into a meter: start, now and the change in points', () => {
    expect(usageMeter(31, 38.4)).toEqual({ start: 31, now: 38.4, delta: 7 });
    // Only the start is known: the meter shows it as now too.
    expect(usageMeter(12, undefined)).toEqual({ start: 12, now: 12, delta: 0 });
    expect(usageMeter(12, null)).toEqual({ start: 12, now: 12, delta: 0 });
    // A window that reset reads lower; the change says so.
    expect(usageMeter(90, 4)).toEqual({ start: 90, now: 4, delta: -86 });
    // Out of range readings stay inside the bar; the change keeps the real figures.
    expect(usageMeter(-3, 130)).toEqual({ start: 0, now: 100, delta: 133 });
    expect(usageMeter(null, 40)).toBeUndefined();
    expect(usageMeter(undefined, 40)).toBeUndefined();
    expect(usageMeter(Number.NaN, 40)).toBeUndefined();
  });

  it('marks the timeline with round values, five at most and none repeated, each at its place', () => {
    const labels = (spanMs: number, lang?: string) => timelineTicks(spanMs, lang).ticks.map((tick) => tick.label);
    expect(timelineTicks(20 * 60_000).unit).toBe('min');
    expect(labels(20 * 60_000)).toEqual(['0', '5', '10', '15', '20']);
    expect(timelineTicks(40_000).unit).toBe('s');
    expect(labels(40_000)).toEqual(['0', '10', '20', '30', '40']);
    expect(labels(800)).toEqual(['0', '0.2', '0.4', '0.6', '0.8']);
    expect(labels(800, 'es')).toEqual(['0', '0,2', '0,4', '0,6', '0,8']);
    // The short spans that used to read "0 · 0.1 · 0.1 · 0.2 · 0.2 s".
    expect(labels(200)).toEqual(['0', '0.05', '0.1', '0.15', '0.2']);
    expect(labels(250)).toEqual(['0', '0.1', '0.2']);
    expect(labels(600)).toEqual(['0', '0.2', '0.4', '0.6']);
    // The real H10 run (8 min 9 s): every two minutes, not just 0 and 5.
    expect(labels(8 * 60_000 + 9_000)).toEqual(['0', '2', '4', '6', '8']);
    expect(labels(4 * 60_000)).toEqual(['0', '1', '2', '3', '4']);
    // Odd spans: the marks stop before the end and sit where their value is.
    expect(timelineTicks(7 * 60_000 + 30_000)).toEqual({
      unit: 'min',
      ticks: [
        { label: '0', at: 0 },
        { label: '2', at: (2 / 7.5) * 100 },
        { label: '4', at: (4 / 7.5) * 100 },
        { label: '6', at: (6 / 7.5) * 100 },
      ],
    });
    expect(timelineTicks(0)).toEqual({ unit: 's', ticks: [{ label: '0', at: 0 }] });
    expect(labels(Number.NaN)).toEqual(['0']);
    for (const span of [130, 999, 4321, 59_000, 61_000, 3_600_000, 5_432_100]) {
      const marks = labels(span);
      expect(new Set(marks).size, String(span)).toBe(marks.length);
      expect(marks.length, String(span)).toBeLessThanOrEqual(5);
      expect(marks.length, String(span)).toBeGreaterThanOrEqual(2);
    }
  });

  it('writes the timeline durations as a clock from one minute up', () => {
    expect(formatClockDuration(4 * 60_000)).toBe('4:00');
    expect(formatClockDuration(8 * 60_000 + 9_400)).toBe('8:09');
    expect(formatClockDuration(3_723_000)).toBe('1:02:03');
    expect(formatClockDuration(45_000)).toBe('45 s');
    expect(formatClockDuration(2_400)).toBe('2.4 s');
    expect(formatClockDuration(undefined)).toBe('—');
  });

  it('reads passed steps as done and a step cut short as stopped, never as waiting for you', () => {
    const states = ['waiting', 'waiting', 'waiting', 'running', 'waiting'];
    expect(stepLooks(states, undefined).map((s) => s.look)).toEqual(['done', 'done', 'done', 'now', 'todo']);
    expect(stepLooks(states, undefined)[0]?.word).toBe('passed');
    expect(stepLooks(states, 'interrupted')[3]).toEqual({ look: 'fail', word: 'interrupted' });
    expect(stepLooks(states, 'failed')[3]).toEqual({ look: 'fail', word: 'interrupted' });
    expect(stepLooks(states, 'cancelled')[3]).toEqual({ look: 'halt', word: 'stopped' });
    expect(stepLooks(states, 'completed')[3]).toEqual({ look: 'done', word: 'passed' });
    expect(stepLooks(['ok', 'skipped', 'failed', 'waiting'], 'failed').map((s) => s.look)).toEqual(['done', 'done', 'fail', 'todo']);
    expect(stepLooks(['waiting', 'waiting'], undefined).map((s) => s.look)).toEqual(['todo', 'todo']);
  });

  it('numbers an agent type that ran more than once', () => {
    const labels = nodeLabels(
      [
        { id: 'main', kind: 'main', agentType: 'main' },
        { id: 'a1', kind: 'agent', agentType: 'interviewer' },
        { id: 'a2', kind: 'agent', agentType: 'interviewer' },
        { id: 'a3', kind: 'agent', agentType: 'architect' },
      ],
      'Main session',
    );
    expect([...labels.values()]).toEqual(['Main session', 'interviewer · 1', 'interviewer · 2', 'architect']);
  });

  it('places a timeline bar inside the track, never thinner than a sliver', () => {
    expect(barGeometry(0, 50, 100)).toEqual({ left: 0, width: 50 });
    expect(barGeometry(25, 25, 100)).toEqual({ left: 25, width: 0.5 });
    expect(barGeometry(90, 150, 100)).toEqual({ left: 90, width: 10 });
    expect(barGeometry(0, 10, 0)).toEqual({ left: 0, width: 100 });
  });

  it('numbers a step from 1', () => {
    const steps = ['idea', 'interview', 'spec'];
    expect(stepNumber(steps, 'idea')).toBe(1);
    expect(stepNumber(steps, 'spec')).toBe(3);
    expect(stepNumber(steps, 'nope')).toBeUndefined();
    expect(stepNumber(steps, undefined)).toBeUndefined();
  });

  it('resolves the system theme to the one the system prefers', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

import { describe, expect, it } from 'vitest';
import { formatDuration, liveFromState, panelEventsFromStream, percent, targetText } from '../../src/ui/panelData.js';
import { parseRoute, routeHash } from '../../src/ui/route.js';
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

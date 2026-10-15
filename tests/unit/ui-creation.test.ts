import { describe, expect, it } from 'vitest';
import { FLOW_STEPS } from '../../src/events/index.js';
import { answerFor, answersFor, defaultSelection, recommendedIndex } from '../../src/ui/answers.js';
import { STEPS, deriveProgress, parseSse } from '../../src/ui/progress.js';
import type { StreamEvent, UiQuestion } from '../../src/ui/types.js';

const question = (overrides: Partial<UiQuestion> = {}): UiQuestion => ({
  question: 'Who is it for?',
  header: 'Audience',
  multiSelect: false,
  options: [
    { label: 'My family', description: 'Shared' },
    { label: 'Just me (Recommended)', description: 'Personal' },
    { label: 'A team', description: 'Work' },
  ],
  ...overrides,
});

describe('answers', () => {
  it('preselects the recommended option, else the first', () => {
    expect(recommendedIndex(question())).toBe(1);
    expect(defaultSelection(question())).toEqual({ picked: [1], own: '' });
    expect(defaultSelection(question({ options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }))).toEqual({ picked: [0], own: '' });
    expect(recommendedIndex(question({ options: [{ label: 'A (recomendada)', description: '' }, { label: 'B (Recomendado)', description: '' }] }))).toBe(0);
    expect(defaultSelection(question({ options: [] }))).toEqual({ picked: [], own: '' });
  });

  it('answers with the label of the option, the labels joined for several, or the own text', () => {
    expect(answerFor(question(), { picked: [1], own: '' })).toBe('Just me (Recommended)');
    expect(answerFor(question({ multiSelect: true }), { picked: [2, 0], own: '' })).toBe('My family, A team');
    expect(answerFor(question(), { picked: [1], own: '  My club  ' })).toBe('My club');
    expect(answerFor(question(), { picked: [], own: '' })).toBeUndefined();
    expect(answerFor(question(), { picked: [9], own: '' })).toBeUndefined();
  });

  it('gives every answer keyed by question text, and nothing while one is open', () => {
    const second = question({ question: 'Which seasons?', options: [{ label: 'All four (Recommended)', description: '' }] });
    const selections = [defaultSelection(question()), defaultSelection(second)];
    expect(answersFor([question(), second], selections)).toEqual({ 'Who is it for?': 'Just me (Recommended)', 'Which seasons?': 'All four (Recommended)' });
    expect(answersFor([question(), second], [selections[0] as never, { picked: [], own: '' }])).toBeUndefined();
    expect(answersFor([question(), second], [selections[0] as never])).toBeUndefined();
  });
});

describe('progress', () => {
  it('lists the same steps as the flow, in the same order', () => {
    expect([...STEPS]).toEqual([...FLOW_STEPS]);
  });

  const at = (seq: number, rest: Omit<StreamEvent, 'seq' | 'ts'>): StreamEvent => ({ seq, ts: '2026-10-15T10:00:00Z', ...rest }) as StreamEvent;

  it('follows steps and agents from the stream', () => {
    const events: StreamEvent[] = [
      at(1, { kind: 'flow', data: { type: 'step.started', step: 'idea' } }),
      at(2, { kind: 'flow', data: { type: 'step.finished', step: 'idea', outcome: 'ok' } }),
      at(3, { kind: 'flow', data: { type: 'step.started', step: 'research' } }),
      at(4, { kind: 'flow', data: { type: 'step.finished', step: 'research', outcome: 'skipped' } }),
      at(5, { kind: 'flow', data: { type: 'step.started', step: 'generate' } }),
      at(6, { kind: 'hook', data: { type: 'subagent.start', agentId: 'a1', agentType: 'generator' } }),
      at(7, { kind: 'hook', data: { type: 'subagent.start', agentId: 'a2', agentType: 'reviewer' } }),
      at(8, { kind: 'hook', data: { type: 'subagent.stop', agentId: 'a2', agentType: 'reviewer' } }),
      at(9, { kind: 'hook', data: { type: 'tool.pre', tool: 'Bash' } }),
    ];
    const progress = deriveProgress(events);
    expect(progress.steps).toMatchObject({ idea: 'ok', research: 'skipped', generate: 'running', handoff: 'waiting' });
    expect(progress.current).toBe('generate');
    expect(progress.agents).toEqual(['generator']);
  });

  it('marks failed steps, ignores unknown ones and reports what the runner denied', () => {
    const events: StreamEvent[] = [
      at(1, { kind: 'flow', data: { type: 'step.started', step: 'spec' } }),
      at(2, { kind: 'flow', data: { type: 'step.finished', step: 'spec', outcome: 'failed' } }),
      at(3, { kind: 'flow', data: { type: 'step.started', step: 'coding' } }),
      at(4, { kind: 'denied', data: { toolName: 'Bash', summary: 'rm -rf /', at: '2026-10-15T10:00:00Z', by: 'runner', reason: 'not allowed' } }),
      at(5, { kind: 'denied', data: { toolName: 'WebFetch', summary: 'https://x', at: '2026-10-15T10:00:01Z', by: 'policy' } }),
    ];
    const progress = deriveProgress(events);
    expect(progress.steps.spec).toBe('failed');
    expect(progress.current).toBeUndefined();
    expect(progress.runnerDenials).toEqual([{ toolName: 'Bash', summary: 'rm -rf /', reason: 'not allowed', at: '2026-10-15T10:00:00Z' }]);
  });
});

describe('parseSse', () => {
  it('reads complete frames and keeps the unfinished rest', () => {
    const first = 'id: 1\nevent: flow\ndata: {"a":1}\n\n: heartbeat\n\nid: 2\nevent: status\ndata: {"b"';
    const { frames, rest } = parseSse(first);
    expect(frames).toEqual([{ id: '1', event: 'flow', data: '{"a":1}' }]);
    expect(rest).toBe('id: 2\nevent: status\ndata: {"b"');
    const next = parseSse(`${rest}:2}\n\n`);
    expect(next.frames).toEqual([{ id: '2', event: 'status', data: '{"b":2}' }]);
    expect(next.rest).toBe('');
  });

  it('handles CRLF, several data lines and a stream of heartbeats only', () => {
    expect(parseSse('id: 3\r\ndata: a\r\ndata: b\r\n\r\n').frames).toEqual([{ id: '3', data: 'a\nb' }]);
    expect(parseSse(': stream\n\n: heartbeat\n\n')).toEqual({ frames: [], rest: '' });
  });
});

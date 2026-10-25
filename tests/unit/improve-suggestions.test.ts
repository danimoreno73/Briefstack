import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreationState } from '../../src/creation/manager.js';
import { appendEvent, flowEvent, sessionLifecycleEvent, type SessionEvent } from '../../src/events/index.js';
import { computeSuggestions, newLessons, suggestionText, SuggestionStore, SuggestionTracker, type Suggestion } from '../../src/improve/suggestions.js';
import type { SessionSignals } from '../../src/improve/signals.js';
import { tempDir } from '../helpers.js';

const NOW = new Date('2026-10-18T12:00:00Z');
const state = (fields: Partial<CreationState> = {}) => ({ id: 'c1', idea: 'A packing list for a trip', sessionId: 's1', ...fields });
const signals = (fields: Partial<SessionSignals> = {}): SessionSignals => ({ sessionId: 's1', reviewRounds: 1, denials: [], failedSteps: [], endedWithoutClose: false, outcome: 'completed', ...fields });

describe('computeSuggestions', () => {
  it('suggests nothing after a clean creation', () => {
    expect(computeSuggestions({ state: state(), signals: signals(), lessons: [] }, NOW)).toEqual([]);
  });

  it('gives at most three, the most important first, each with its target', () => {
    const found = computeSuggestions(
      {
        state: state({ textTurns: 2 }),
        signals: signals({ outcome: 'failed', failedSteps: ['generate'], reviewRounds: 3, denials: [{ tool: 'Write', by: 'guard', agent: 'generator' }, { tool: 'Write', by: 'guard', agent: 'generator' }] }),
        lessons: ['Do not ask for the folder twice.'],
      },
      NOW,
    );
    expect(found.map((s) => [s.kind, s.target])).toEqual([
      ['failure', '.claude/skills/new-project/SKILL.md'],
      ['textQuestions', '.claude/skills/new-project/SKILL.md'],
      ['denials', '.claude/agents/generator.md'],
    ]);
    expect(found[2]?.params).toEqual({ count: 2, tools: ['Write'] });
    expect(new Set(found.map((s) => s.id)).size).toBe(3);
    expect(found.every((s) => s.creationId === 'c1' && s.sessionId === 's1')).toBe(true);
  });

  it('suggests from review rounds and lessons, redacted', () => {
    const key = ['sk', 'ant', 'a'.repeat(30)].join('-');
    const found = computeSuggestions({ state: state(), signals: signals({ reviewRounds: 2 }), lessons: [`Never ask for the key ${key}.`] }, NOW);
    expect(found.map((s) => s.kind)).toEqual(['reviewRounds', 'lessons']);
    expect(JSON.stringify(found)).not.toContain(key);
    expect(suggestionText(found[0] as Suggestion)).toContain('2 rounds');
  });

  it('reads new lessons without date headings', () => {
    expect(newLessons('# Lessons\n\nOld.\n', '# Lessons\n\nOld.\n\n### 2026-10-18\n\n- Ask less.\n- Use defaults.\n')).toEqual(['- Ask less.', '- Use defaults.']);
  });
});

describe('suggestion store and tracker', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('suggestions'));
  });
  afterEach(async () => {
    await cleanup();
  });

  it('stores newest first and marks one used', async () => {
    const store = new SuggestionStore(path.join(dir, 'improve', 'suggestions.json'));
    expect(await store.list()).toEqual([]);
    const [a, b] = computeSuggestions({ state: state({ textTurns: 1 }), signals: signals({ reviewRounds: 2 }), lessons: [] }, NOW);
    await store.add([a as Suggestion]);
    await store.add([b as Suggestion]);
    expect((await store.list()).map((s) => s.kind)).toEqual(['reviewRounds', 'textQuestions']);
    await store.markUsed((a as Suggestion).id, 'imp-abcdef-0000');
    expect((await store.get((a as Suggestion).id))?.proposalId).toBe('imp-abcdef-0000');
  });

  it('computes them when a creation finishes, from its events and the lessons it added, and announces them', async () => {
    const libraryDir = path.join(dir, 'library');
    const sessionsDir = path.join(dir, 'sessions');
    await mkdir(libraryDir, { recursive: true });
    await writeFile(path.join(libraryDir, 'lessons.md'), '# Lessons\n\nOld one.\n', 'utf8');
    const store = new SuggestionStore(path.join(dir, 'improve', 'suggestions.json'));
    const announced: Suggestion[][] = [];
    const tracker = new SuggestionTracker({ store, locations: async () => ({ libraryDir, sessionsDir }), homedir: dir, announce: (list) => announced.push(list), now: () => NOW });
    const creation = { ...state(), profile: 'saver', policy: 'ask', status: 'running', denied: [], startedAt: NOW.toISOString() } as CreationState;
    tracker.started(creation);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
    const events: SessionEvent[] = [
      sessionLifecycleEvent('s1', 'started', undefined, at(0)),
      { v: 1, ts: at(1).toISOString(), session: 's1', source: 'hook', type: 'subagent.start', agentType: 'reviewer', agentId: 'r1' },
      { v: 1, ts: at(2).toISOString(), session: 's1', source: 'hook', type: 'subagent.start', agentType: 'reviewer', agentId: 'r2' },
      flowEvent('s1', 'learn', 'finished', 'ok', at(3)),
      sessionLifecycleEvent('s1', 'finished', 'completed', at(4)),
    ];
    for (const event of events) await appendEvent(sessionsDir, event);
    await writeFile(path.join(libraryDir, 'lessons.md'), '# Lessons\n\nOld one.\n\n### 2026-10-18\n\nDo not ask for the folder twice.\n', 'utf8');
    const found = await tracker.finished({ ...creation, status: 'finished', outcome: 'completed' });
    expect(found.map((s) => s.kind)).toEqual(['reviewRounds', 'lessons']);
    expect(found[1]?.params.lines).toEqual(['Do not ask for the folder twice.']);
    expect((await store.list()).map((s) => s.id)).toEqual(found.map((s) => s.id));
    expect(announced).toEqual([found]);
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeChoiceProblems, specOffersCode, type CodeChoice } from '../../src/creation/code.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager, type CreationState } from '../../src/creation/manager.js';
import type { SpecDecision } from '../../src/creation/types.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specInput, tempDir } from '../helpers.js';

// The code choice at the spec checkpoint (PLAN-phase-10 §1, 1 and 2): offered for a `software` spec for Claude Code
// only; the lists validated as builds' are; Codex only when available for creations; recorded on the creation and in
// the session folder; "workspace only" tells the flow exactly what it was told before phase 10.

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CHOICE: CodeChoice = { commands: ['npm install', 'npm test'], checks: ['npm test'], fixPasses: 1, codex: false };

describe('codeChoiceProblems and specOffersCode', () => {
  it('the lists follow builds: exact single commands, no duplicates, within the limits; Codex only when offered', () => {
    expect(codeChoiceProblems(CHOICE, { codexOffered: false })).toEqual([]);
    expect(codeChoiceProblems({ ...CHOICE, commands: ['npm test && rm -rf .'] }, { codexOffered: false })).toEqual(['commands line 1: more than one command (list each part on its own)']);
    expect(codeChoiceProblems({ ...CHOICE, checks: ['npm test', 'npm test'] }, { codexOffered: false })).toEqual(['checks: the same command twice']);
    expect(codeChoiceProblems({ ...CHOICE, commands: Array.from({ length: 21 }, (_, i) => `npm run s${i}`) }, { codexOffered: false })[0]).toBe('commands: at most 20');
    expect(codeChoiceProblems({ ...CHOICE, codex: true }, { codexOffered: false })).toHaveLength(1);
    expect(codeChoiceProblems({ ...CHOICE, codex: true }, { codexOffered: true })).toEqual([]);
  });

  it('code is offered for a software project for Claude Code only', () => {
    expect(specOffersCode({ type: 'software', target: 'claude-code' })).toBe(true);
    expect(specOffersCode({ type: 'software', target: 'claude-app' })).toBe(false);
    expect(specOffersCode({ type: 'generic', target: 'claude-code' })).toBe(false);
    expect(specOffersCode(null)).toBe(false);
  });
});

describe('the code choice at the spec checkpoint', { timeout: 30_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let sessionsDir: string;
  let manager: CreationManager | undefined;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('creation-code'));
    sessionsDir = path.join(dir, 'sessions');
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  async function atSpec(spec: SpecInput, codex = false): Promise<{ m: CreationManager; id: string; pendingId: string; decisions: SpecDecision[] }> {
    const decisions: SpecDecision[] = [];
    const steps = parseRecording(
      [
        { do: 'session', phase: 'started' },
        { do: 'label', name: 'write' },
        { do: 'spec', onChange: 'write', spec: JSON.stringify(spec) },
        { do: 'session', phase: 'finished', outcome: 'completed' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    manager = new CreationManager({
      runner: new FakeRunner({ steps, decisions }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
      codexForCreations: async () => codex,
    });
    const m = manager;
    const { id } = await m.create('A garden planner');
    const waiting = await waitFor(() => (m.get(id).pending?.kind === 'spec' ? m.get(id) : undefined));
    return { m, id, pendingId: waiting.pending?.id ?? '', decisions };
  }

  const finished = (m: CreationManager, id: string) => waitFor((): CreationState | undefined => (m.get(id).status === 'finished' ? m.get(id) : undefined));

  it('"workspace only" tells the flow what it was told before, and records no code', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }));
    expect((await m.readSpec(id)).code).toMatchObject({ offered: true, codex: false, maxCommands: 20, maxChecks: 10, maxFixPasses: 2, defaultFixPasses: 1 });
    m.answer(id, pendingId, { decision: 'approve' });
    const final = await finished(m, id);
    expect(decisions).toEqual([{ decision: 'approve' }]);
    expect(final.code).toBeUndefined();
    await expect(readFile(path.join(sessionsDir, final.sessionId ?? '', 'code.json'), 'utf8')).rejects.toThrow();
  });

  it('code chosen: validated, recorded on the creation and in code.json, and the flow is told', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }));
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, commands: ['npm test | tee out'] } })).toThrow();
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, codex: true } })).toThrow();
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, fixPasses: 3 } })).toThrow();
    expect(m.get(id).pending?.kind).toBe('spec');
    m.answer(id, pendingId, { decision: 'approve', code: CHOICE });
    const final = await finished(m, id);
    expect(decisions).toEqual([expect.objectContaining({ decision: 'approve', code: true })]);
    expect(final.code).toEqual(CHOICE);
    expect(JSON.parse(await readFile(path.join(sessionsDir, final.sessionId ?? '', 'code.json'), 'utf8'))).toEqual({ v: 1, ...CHOICE });
  });

  it('is refused for a spec that is not software for Claude Code', async () => {
    const { m, id, pendingId } = await atSpec(specInput({ type: 'generic', target: 'claude-code' }));
    expect((await m.readSpec(id)).code).toMatchObject({ offered: false, codex: false });
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: CHOICE })).toThrow();
  });

  it('offers Codex only when it is available for creations', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }), true);
    expect((await m.readSpec(id)).code).toMatchObject({ offered: true, codex: true });
    m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, codex: true } });
    expect((await finished(m, id)).code).toEqual({ ...CHOICE, codex: true });
    expect(decisions).toEqual([expect.objectContaining({ code: true })]);
  });
});

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeChoiceIssues, hasCodeIssues, specOffersCode, type CodeChoice } from '../../src/creation/code.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { realImplementSystem } from '../../src/creation/implementSystem.js';
import { CreationManager, type CreationState } from '../../src/creation/manager.js';
import type { SpecDecision } from '../../src/creation/types.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specInput, tempDir } from '../helpers.js';

// The code choice at the spec checkpoint (PLAN-phase-10 §1, 1 and 2): offered for a `software` spec for Claude Code
// only, and only when the implement step is wired (review of M1, I1); the lists validated as builds' are, a check at
// least (I3); Codex only when available for creations; recorded on the creation and in the session folder only on a
// final approval (m4); "workspace only" tells the flow exactly what it was told before phase 10.

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

const invalidCode = (params: Record<string, unknown>) => expect.objectContaining({ code: 'creation.invalidCode', params: expect.objectContaining(params) });

describe('codeChoiceIssues and specOffersCode', () => {
  it('the lists follow builds: exact single commands, no duplicates, within the limits; a check at least; Codex only when offered', () => {
    expect(hasCodeIssues(codeChoiceIssues(CHOICE, { codexOffered: false }))).toBe(false);
    expect(codeChoiceIssues({ ...CHOICE, commands: ['npm test && rm -rf .'] }, { codexOffered: false }).items).toEqual([{ key: 'listLine', what: 'commands', line: 1, problem: 'compound' }]);
    expect(codeChoiceIssues({ ...CHOICE, checks: ['npm test', 'npm test'] }, { codexOffered: false }).items).toEqual([{ key: 'listDuplicate', what: 'checks' }]);
    expect(codeChoiceIssues({ ...CHOICE, commands: Array.from({ length: 21 }, (_, i) => `npm run s${i}`) }, { codexOffered: false }).items[0]).toEqual({ key: 'listTooLong', what: 'commands', max: 20 });
    expect(codeChoiceIssues({ ...CHOICE, checks: [] }, { codexOffered: false }).noChecks).toBe(true);
    expect(codeChoiceIssues({ ...CHOICE, commands: [] }, { codexOffered: false })).toEqual({ items: [], codex: false, noChecks: false });
    expect(codeChoiceIssues({ ...CHOICE, codex: true }, { codexOffered: false }).codex).toBe(true);
    expect(hasCodeIssues(codeChoiceIssues({ ...CHOICE, codex: true }, { codexOffered: true }))).toBe(false);
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

  async function atSpec(spec: SpecInput, options: { codex?: () => Promise<boolean>; wired?: boolean; twice?: boolean } = {}) {
    const decisions: SpecDecision[] = [];
    const steps = parseRecording(
      [
        { do: 'session', phase: 'started' },
        { do: 'label', name: 'write' },
        { do: 'spec', onChange: 'write', spec: JSON.stringify(spec) },
        ...(options.twice === true ? [{ do: 'label', name: 'again' }, { do: 'spec', onChange: 'again', spec: JSON.stringify(spec) }] : []),
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
      codexForCreations: options.codex ?? (async () => false),
      ...(options.wired === false ? {} : { implement: realImplementSystem() }),
    });
    const m = manager;
    const { id } = await m.create('A garden planner');
    const atPending = async (n: number) => (await waitFor(() => (m.get(id).pending?.kind === 'spec' && m.get(id).pending?.id === `p${n}` ? m.get(id) : undefined))).pending?.id ?? '';
    return { m, id, pendingId: await atPending(1), atPending, decisions };
  }

  const finished = (m: CreationManager, id: string) => waitFor((): CreationState | undefined => (m.get(id).status === 'finished' ? m.get(id) : undefined));
  const codeFile = (state: CreationState) => path.join(sessionsDir, state.sessionId ?? '', 'code.json');

  it('"workspace only" tells the flow what it was told before, and records no code', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }));
    expect((await m.readSpec(id)).code).toMatchObject({ offered: true, codex: false, maxCommands: 20, maxChecks: 10, maxFixPasses: 2, defaultFixPasses: 1 });
    m.answer(id, pendingId, { decision: 'approve' });
    const final = await finished(m, id);
    expect(decisions).toEqual([{ decision: 'approve' }]);
    expect(final.code).toBeUndefined();
    await expect(stat(codeFile(final))).rejects.toThrow();
  });

  it('code chosen: refused with codes when the lists are wrong or there is no check; recorded and told when right', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }));
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, commands: ['npm test | tee out'] } })).toThrow(
      invalidCode({ items: [{ key: 'listLine', what: 'commands', line: 1, problem: 'compound' }], codex: false, noChecks: false }),
    );
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, checks: [] } })).toThrow(invalidCode({ noChecks: true }));
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, codex: true } })).toThrow(invalidCode({ codex: true }));
    // Out of the schema: refused before the code's own checks.
    expect(() => m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, fixPasses: 3 } })).toThrow(expect.objectContaining({ code: 'creation.invalidAnswer' }));
    expect(m.get(id).pending?.kind).toBe('spec');
    m.answer(id, pendingId, { decision: 'approve', code: CHOICE });
    const final = await finished(m, id);
    expect(decisions).toEqual([expect.objectContaining({ decision: 'approve', code: true })]);
    expect(final.code).toEqual(CHOICE);
    expect(JSON.parse(await readFile(codeFile(final), 'utf8'))).toEqual({ v: 1, ...CHOICE });
  });

  it('a change and a second approval replace the choice; workspace only at the end removes it and its file', async () => {
    const { m, id, pendingId, atPending, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }), { twice: true });
    m.answer(id, pendingId, { decision: 'approve', code: CHOICE });
    await waitFor(() => (m.get(id).code !== undefined ? true : undefined));
    m.answer(id, await atPending(2), { decision: 'approve' });
    const final = await finished(m, id);
    expect(decisions).toEqual([expect.objectContaining({ code: true }), { decision: 'approve' }]);
    expect(final.code).toBeUndefined();
    await expect(stat(codeFile(final))).rejects.toThrow();
  });

  it('library skills unticked and code together: both reach the flow', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }));
    m.answer(id, pendingId, { decision: 'approve', removeSkills: ['nothing-here'], code: CHOICE });
    await finished(m, id);
    expect(decisions).toEqual([expect.objectContaining({ decision: 'approve', removedLibrarySkills: [], code: true })]);
  });

  it('is refused for a spec that is not software for Claude Code, and not offered when the implement step is not wired', async () => {
    const generic = await atSpec(specInput({ type: 'generic', target: 'claude-code' }));
    expect((await generic.m.readSpec(generic.id)).code).toMatchObject({ offered: false, codex: false });
    expect(() => generic.m.answer(generic.id, generic.pendingId, { decision: 'approve', code: CHOICE })).toThrow(invalidCode({ notOffered: true }));
    await manager?.shutdown();
    const unwired = await atSpec(specInput({ type: 'software', target: 'claude-code' }), { wired: false });
    expect((await unwired.m.readSpec(unwired.id)).code.offered).toBe(false);
    expect(() => unwired.m.answer(unwired.id, unwired.pendingId, { decision: 'approve', code: CHOICE })).toThrow(invalidCode({ notOffered: true }));
  });

  it('offers Codex only when it is available for creations; a failing reading offers none', async () => {
    const { m, id, pendingId, decisions } = await atSpec(specInput({ type: 'software', target: 'claude-code' }), { codex: async () => true });
    expect((await m.readSpec(id)).code).toMatchObject({ offered: true, codex: true });
    m.answer(id, pendingId, { decision: 'approve', code: { ...CHOICE, codex: true } });
    expect((await finished(m, id)).code).toEqual({ ...CHOICE, codex: true });
    expect(decisions).toEqual([expect.objectContaining({ code: true })]);
    await manager?.shutdown();
    const failing = await atSpec(specInput({ type: 'software', target: 'claude-code' }), { codex: () => Promise.reject(new Error('no codex')) });
    expect((await failing.m.readSpec(failing.id)).code).toMatchObject({ offered: true, codex: false });
  });
});

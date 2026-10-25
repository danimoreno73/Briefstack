import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathEnv } from '../../src/config/index.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager } from '../../src/creation/manager.js';
import { FakeImprovementRunner } from '../../src/improve/fakeRunner.js';
import type { ImprovementManager } from '../../src/improve/manager.js';
import { FakeRealCheckRunner } from '../../src/improve/realCheck.js';
import { MAX_TEXT_TURN_SESSIONS, TextTurnStore } from '../../src/improve/textTurns.js';
import { FakeVerifier } from '../../src/improve/verify.js';
import { createWebImprovements } from '../../src/improve/wiring.js';
import { tempDir, useHermeticGit } from '../helpers.js';
import { makeImproveRepo, researcherRound } from '../improveWorld.js';

useHermeticGit();

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('improve-text-turns'));
});

afterEach(async () => {
  await cleanup();
});

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('TextTurnStore', () => {
  it('keeps the latest count per session, newest first, and a repeated count changes nothing', async () => {
    const file = path.join(dir, 'improve', 'text-turns.json');
    const store = new TextTurnStore(file);
    expect(await store.count('s1')).toBeUndefined();
    await store.record('s1', 1);
    await store.record('s2', 1);
    await store.record('s1', 2);
    await store.record('s1', 2);
    expect(await store.count('s1')).toBe(2);
    expect(await store.count('s2')).toBe(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, sessions: [{ id: 's1', count: 2 }, { id: 's2', count: 1 }] });
  });

  it('keeps at most the newest sessions, writes nothing for a bad id or count, and reads a damaged file as empty', async () => {
    const file = path.join(dir, 'text-turns.json');
    const store = new TextTurnStore(file);
    await Promise.all(Array.from({ length: MAX_TEXT_TURN_SESSIONS + 5 }, (_, i) => store.record(`s${i}`, 1)));
    expect(await store.count('s0')).toBeUndefined();
    expect(await store.count(`s${MAX_TEXT_TURN_SESSIONS + 4}`)).toBe(1);
    expect((JSON.parse(await readFile(file, 'utf8')) as { sessions: unknown[] }).sessions).toHaveLength(MAX_TEXT_TURN_SESSIONS);

    const other = new TextTurnStore(path.join(dir, 'other.json'));
    await other.record('../x', 1);
    await other.record('s1', 0);
    await other.record('s1', 1.5);
    await expect(readFile(path.join(dir, 'other.json'), 'utf8')).rejects.toThrow();

    await mkdir(dir, { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    expect(await store.count('s1')).toBeUndefined();
    await writeFile(file, JSON.stringify({ sessions: [{ id: 's1', count: 'two' }, { id: 's2', count: 3 }] }), 'utf8');
    expect(await store.count('s1')).toBeUndefined();
    expect(await store.count('s2')).toBe(3);
  });
});

describe('turns that ended in text outlive a restart of the server', () => {
  it('are kept on disk while the creation runs, and reach the evidence of an improvement prepared after the restart', async () => {
    const home = path.join(dir, 'home');
    const repoDir = path.join(dir, 'repo');
    await makeImproveRepo(repoDir);
    const pathEnv: PathEnv = { env: { BRIEFSTACK_HOME: home }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
    const sessionsDir = path.join(home, 'sessions');
    const creationsOf = (recording: string) =>
      new CreationManager({
        runner: new FakeRunner({ steps: parseRecording(recording), projectsDir: path.join(dir, 'projects') }),
        sessionsDir,
        policy: () => 'ask',
        profile: () => ({ name: 'balanced', sessionModel: 'sonnet' }),
        pollMs: 10,
        tailMs: 20,
      });
    const improvementsOf = async (creations: CreationManager, runner = new FakeImprovementRunner({ rounds: [researcherRound()] })) => ({
      runner,
      manager: await createWebImprovements({ pathEnv, repoDir, creations, runner, verifier: new FakeVerifier(), realChecks: new FakeRealCheckRunner(), gatePollMs: 50 }),
    });

    // Before the restart: a creation whose turn ends in text.
    const before = creationsOf(['{"do":"session","phase":"started"}', '{"do":"turnEnd","message":"Which name?"}', '{"do":"session","phase":"finished"}'].join('\n'));
    const first = await improvementsOf(before);
    const turnsFile = path.join(home, 'improve', 'text-turns.json');
    const { id } = await before.create('A packing list');
    await waitFor(() => before.get(id).awaitingReply);
    const sessionId = before.get(id).sessionId ?? '';
    expect(sessionId).not.toBe('');
    const saved = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(turnsFile, 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    });
    expect(saved).toEqual({ v: 1, sessions: [{ id: sessionId, count: 1 }] });
    before.reply(id, 'Seedling');
    await waitFor(() => (before.get(id).status === 'finished' ? true : undefined));
    await first.manager.shutdown();
    await before.shutdown();

    // After the restart: the new creation manager has never seen that creation.
    const after = creationsOf('{"do":"session","phase":"started"}');
    const second = await improvementsOf(after);
    const improvements: ImprovementManager = second.manager;
    try {
      expect(after.list()).toEqual([]);
      const started = await improvements.prepare('The flow asked in plain text.', { sessions: [sessionId] });
      await waitFor(async () => (['preparing', 'verifying'].includes((await improvements.get(started.id)).status) ? undefined : true));
      const evidenceDir = second.runner.started[0]?.evidenceDir ?? '';
      const evidence = JSON.parse(await readFile(path.join(evidenceDir, 'sessions', `${sessionId}.json`), 'utf8')) as { textTurns?: number };
      expect(evidence.textTurns).toBe(1);
    } finally {
      await improvements.shutdown();
      await after.shutdown();
    }
  });
});

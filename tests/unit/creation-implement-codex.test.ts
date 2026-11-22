import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_NO_SHELL_EXEC_ARGS } from '../../src/codex/limits.js';
import type { CodexSession } from '../../src/codex/tool.js';
import type { CodeChoice } from '../../src/creation/code.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { realImplementSystem } from '../../src/creation/implementSystem.js';
import { CreationManager, type CreationState } from '../../src/creation/manager.js';
import { initLibrary } from '../../src/library/index.js';
import { git } from '../../src/library/git.js';
import { fakeCodex } from '../codexWorld.js';
import { specInput, tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

// Codex without its shell in the implement step (PLAN-phase-10 §1, 9; M4), with the fake Codex CLI: the call has the
// measured no-shell arguments and nothing from Claude but the instruction (on stdin); Codex writes with its file tool
// and runs nothing; the calls are capped for the whole step and recorded; with the checkbox off, or Codex not
// available when the step starts, it is not called.

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CHOICE: CodeChoice = { commands: [], checks: ['node --version'], fixPasses: 0, codex: true };

describe('Codex without its shell in a creation', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let projectsDir: string;
  let sessionsDir: string;
  let libraryDir: string;
  let log: string;
  let manager: CreationManager | undefined;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('creation-codex'));
    projectsDir = path.join(dir, 'projects');
    sessionsDir = path.join(dir, 'sessions');
    libraryDir = path.join(dir, 'library');
    log = path.join(dir, 'codex.jsonl');
    await writeFile(log, '', 'utf8');
    await initLibrary({ libraryDir, projectsDir, sessionsDir, repoDir: path.join(dir, 'repo') });
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  async function run(choice: CodeChoice, session: Omit<CodexSession, 'outDir'> | undefined, instructions: string[]) {
    const replies: string[] = [];
    const steps = parseRecording(
      [
        { do: 'session', phase: 'started' },
        { do: 'claim', dir: 'garden' },
        { do: 'spec', onChange: 'x', spec: JSON.stringify(specInput({ slug: 'garden', type: 'software', target: 'claude-code' })) },
        { do: 'label', name: 'x' },
        { do: 'generate', dir: 'garden', git: true },
        { do: 'implement', action: 'start', dir: 'garden' },
        ...instructions.map((text) => ({ do: 'implement', action: 'codex', text })),
        { do: 'implement', action: 'finish' },
        { do: 'session', phase: 'finished', outcome: 'completed' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    manager = new CreationManager({
      runner: new FakeRunner({ steps, projectsDir, libraryDir, implementReplies: replies }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
      implement: realImplementSystem(),
      codexForCreations: async () => true,
      implementCodex: async () => session,
    });
    const m = manager;
    const { id } = await m.create('A garden planner');
    const waiting = await waitFor(() => (m.get(id).pending?.kind === 'spec' ? m.get(id) : undefined));
    m.answer(id, waiting.pending?.id ?? '', { decision: 'approve', code: choice });
    const final = await waitFor((): CreationState | undefined => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; stdin?: string; suspect: string[] });
    return { final, replies, calls };
  }

  it('calls Codex with the measured no-shell arguments; it writes with its file tool, runs nothing, and the code commit holds it', async () => {
    const { final, replies, calls } = await run(CHOICE, { command: fakeCodex(log), maxCalls: 2, ...(process.platform === 'win32' ? { mode: 'unelevated' as const } : {}) }, ['Write codex-note.txt. [fake:cmd]']);
    expect(replies.find((text) => text.startsWith('The implement step started'))).toContain('Codex: on (delegate_to_codex, without its shell)');
    const exec = calls.filter((call) => call.argv[0] === 'exec');
    expect(exec).toHaveLength(1);
    const argv = exec[0]?.argv ?? [];
    // The measured set, in order, right after --ephemeral; the instruction only on stdin; no credentials of ours.
    expect(argv.slice(0, 5 + CODEX_NO_SHELL_EXEC_ARGS.length)).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--ephemeral', ...CODEX_NO_SHELL_EXEC_ARGS]);
    expect(argv.at(-1)).toBe('-');
    expect(argv.join(' ')).not.toContain('codex-note');
    expect(exec[0]?.stdin).toBe('Write codex-note.txt. [fake:cmd]');
    expect(exec[0]?.suspect).toEqual([]);
    expect(final.implement?.codex).toHaveLength(1);
    expect(final.implement?.codex[0]).toMatchObject({ n: 1, outcome: 'completed', commands: 0 });
    expect(final.implement?.codex[0]?.message).toContain('no shell-command tool');
    const project = path.join(projectsDir, 'garden');
    expect(await readFile(path.join(project, 'codex-note.txt'), 'utf8')).toContain('without its shell');
    expect((await git(project, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n')).toEqual(['codex-note.txt']);
  });

  it('caps the calls for the whole step', async () => {
    const { final, replies, calls } = await run(CHOICE, { command: fakeCodex(log), maxCalls: 1 }, ['first', 'second']);
    expect(calls.filter((call) => call.argv[0] === 'exec')).toHaveLength(1);
    expect(final.implement?.codex).toHaveLength(1);
    expect(replies.some((text) => text.includes('the most the user allows (1)'))).toBe(true);
  });

  it('with the checkbox off, Codex is not called', async () => {
    const { final, replies, calls } = await run({ ...CHOICE, codex: false }, { command: fakeCodex(log), maxCalls: 2 }, ['write it']);
    expect(calls).toEqual([]);
    expect(final.implement?.codex).toEqual([]);
    expect(replies.some((text) => text.includes('did not tick Codex'))).toBe(true);
  });

  it('ticked but not available when the step starts: off for the step, said, and not called', async () => {
    const { final, replies, calls } = await run(CHOICE, undefined, ['write it']);
    expect(calls).toEqual([]);
    expect(final.implement).toMatchObject({ codexUnavailable: true, codex: [] });
    expect(replies.find((text) => text.startsWith('The implement step started'))).toContain('not available now');
    expect(replies.some((text) => text.includes('Codex is not available now'))).toBe(true);
  });
});

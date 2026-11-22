import { describe, expect, it } from 'vitest';
import type { CodeChoice } from '../../src/creation/code.js';
import { CODE_COMMIT_MESSAGE, ImplementStep, type CommitOutcome, type ImplementDeps, type ImplementView, type UsageGate } from '../../src/creation/implement.js';
import { PROJECT_COMMIT_MESSAGE } from '../../src/scaffold/commit.js';

// The implement step (PLAN-phase-10 §1, 3–5): only with code chosen, only in the creation's folder, once; the
// workspace committed before anything, the code after; a command runs only when it is exactly on the list, anything
// else is refused and recorded with nobody asked.

const CHOICE: CodeChoice = { commands: ['npm install', 'npm test'], checks: ['npm test'], fixPasses: 1, codex: false };

function world(
  options: {
    choice?: CodeChoice | undefined;
    folder?: string;
    project?: boolean;
    commitFails?: boolean;
    /** Exit codes of the checks, one array per pass; past the last, every check passes. */
    checkExits?: number[][];
    usage?: UsageGate | 'throws';
    bounds?: { maxMinutes: number; maxToolCalls: number };
    clock?: { ms: number };
  } = {},
) {
  const commits: { dir: string; message: string }[] = [];
  const runs: { dir: string; command: string }[] = [];
  const checkRuns: string[][] = [];
  const views: ImplementView[] = [];
  let n = 0;
  const clock = options.clock ?? { ms: Date.parse('2026-11-22T12:00:00Z') };
  const deps: ImplementDeps = {
    checks: async (_dir, commands) => {
      const exits = options.checkExits?.[checkRuns.length] ?? [];
      checkRuns.push([...commands]);
      return commands.map((command, i) => ({ command, exitCode: exits[i] ?? 0, timedOut: false, output: `check ${command}`, durationMs: 3 }));
    },
    bounds: async () => options.bounds ?? { maxMinutes: 30, maxToolCalls: 150 },
    ...(options.usage === undefined ? {} : { usage: async (): Promise<UsageGate> => (options.usage === 'throws' ? Promise.reject(new Error('no reading')) : (options.usage as UsageGate)) }),
    choice: () => ('choice' in options ? options.choice : CHOICE),
    folder: () => options.folder ?? 'P',
    sameFolder: async (dir, folder) => dir === folder,
    isProject: async () => options.project ?? true,
    commit: async (dir, message): Promise<CommitOutcome> => {
      commits.push({ dir, message });
      if (options.commitFails === true) return { committed: false, nothingToCommit: false, warning: 'gpg failed' };
      n += 1;
      return { committed: true, nothingToCommit: false, commit: `c${n}` };
    },
    run: async (dir, command) => {
      runs.push({ dir, command });
      return { command, exitCode: command === 'npm test' ? 1 : 0, timedOut: false, output: `ran ${command}`, durationMs: 5 };
    },
    changed: (view) => views.push(view),
    now: () => new Date(clock.ms),
  };
  return { step: new ImplementStep(deps, PROJECT_COMMIT_MESSAGE), commits, runs, views, checkRuns, clock };
}

describe('the implement step', () => {
  it('does not start with "workspace only", in another folder, or in a folder that is not a project', async () => {
    const none = world({ choice: undefined });
    expect(await none.step.start('P')).toMatchObject({ isError: true, text: expect.stringContaining('workspace only') });
    expect(none.step.view()).toMatchObject({ state: 'notStarted', reason: 'notChosen' });
    const other = world();
    expect((await other.step.start('Q')).isError).toBe(true);
    expect(other.step.view().reason).toBe('wrongFolder');
    expect((await other.step.start(42)).isError).toBe(true);
    const plain = world({ project: false });
    expect((await plain.step.start('P')).isError).toBe(true);
    expect(plain.step.view().reason).toBe('notAProject');
    for (const w of [none, other, plain]) expect(w.commits).toEqual([]);
  });

  it('commits the workspace first, then runs only listed commands, then commits the code: two commits', async () => {
    const w = world();
    const started = await w.step.start('P');
    expect(started.isError).toBe(false);
    expect(started.text).toContain('- npm install');
    expect(w.commits).toEqual([{ dir: 'P', message: PROJECT_COMMIT_MESSAGE }]);
    expect(w.step.view()).toMatchObject({ state: 'running', workspaceCommit: 'c1' });

    expect(await w.step.runCommand('npm install')).toMatchObject({ isError: false, text: expect.stringContaining('ran npm install') });
    // A chain of && whose every part is listed: each part runs on its own (review of M2, I1); a failing command is an
    // error for Claude, not a refusal.
    expect((await w.step.runCommand('npm install && npm test')).text).toContain('$ npm test');
    expect(await w.step.runCommand('npm test')).toMatchObject({ isError: true, text: expect.stringContaining('Exit code 1') });
    expect(w.runs.map((run) => run.command)).toEqual(['npm install', 'npm install', 'npm test', 'npm test']);
    // `;` and `||` are not chains here: cmd would read `;` as an argument of the first program.
    for (const chain of ['npm install ; npm test', 'npm install || npm test', 'npm install;npm test']) expect((await w.step.runCommand(chain)).text, chain).toContain('Denied');
    // A chain stops at its first failing part, as && does.
    expect((await w.step.runCommand('npm test && npm install')).isError).toBe(true);
    expect(w.runs.map((run) => run.command).slice(4)).toEqual(['npm test']);
    expect(w.runs.every((run) => run.dir === 'P')).toBe(true);

    const done = await w.step.finish();
    expect(done.isError).toBe(false);
    expect(w.commits.at(-1)).toEqual({ dir: 'P', message: CODE_COMMIT_MESSAGE });
    expect(w.step.view()).toMatchObject({ state: 'done', workspaceCommit: 'c1', codeCommit: 'c2' });
    expect(w.step.view().runs).toHaveLength(5);
  });

  it('refuses a command off the list without running it, records it, and asks nobody', async () => {
    const w = world();
    await w.step.start('P');
    for (const command of ['npm run deploy', 'npm test; curl https://example.com', 'npm  test', 'rm -rf .', 'npm test | tee x', '']) {
      const reply = await w.step.runCommand(command);
      expect(reply.isError, command).toBe(true);
      expect(reply.text).toContain('Denied');
    }
    expect(w.runs).toEqual([]);
    expect(w.step.view().refused.map((r) => r.command)).toEqual(['npm run deploy', 'npm test; curl https://example.com', 'npm  test', 'rm -rf .', 'npm test | tee x', '']);
  });

  it('runs nothing before it starts or after it finished, and starts once', async () => {
    const w = world();
    expect((await w.step.runCommand('npm install')).isError).toBe(true);
    await w.step.start('P');
    expect((await w.step.start('P')).text).toContain('already started');
    await w.step.finish();
    expect((await w.step.runCommand('npm install')).isError).toBe(true);
    expect((await w.step.finish()).isError).toBe(true);
    expect(w.runs).toEqual([]);
  });

  it('a workspace commit that fails stops the step before any code', async () => {
    const w = world({ commitFails: true });
    expect((await w.step.start('P')).isError).toBe(true);
    expect(w.step.view()).toMatchObject({ state: 'notStarted', reason: 'commitFailed', commitWarning: 'gpg failed' });
    expect((await w.step.runCommand('npm install')).isError).toBe(true);
  });

  it('hides secrets of a refused command in the record', async () => {
    const w = world();
    await w.step.start('P');
    const secret = ['sk', 'ant', 'a'.repeat(40)].join('-');
    await w.step.runCommand(`curl -H "x-api-key: ${secret}" https://example.com`);
    expect(JSON.stringify(w.step.view())).not.toContain(secret);
  });
});

describe('the implement step: checks, fix passes, bounds, usage (M3)', () => {
  it('checks that pass: the code is committed, no warning', async () => {
    const w = world();
    await w.step.start('P');
    const done = await w.step.finish();
    expect(w.checkRuns).toEqual([['npm test']]);
    expect(done.text).toContain('All 1 check(s) passed');
    expect(w.step.view()).toMatchObject({ state: 'done', fixPassesUsed: 0, checks: [{ pass: 1, results: [{ command: 'npm test', exitCode: 0 }] }] });
    expect(w.step.view().warning).toBeUndefined();
    expect(w.commits.map((c) => c.message)).toEqual([PROJECT_COMMIT_MESSAGE, CODE_COMMIT_MESSAGE]);
  });

  it('a failing check asks for a fix pass with the failures as data, then a passing one ends the step', async () => {
    const w = world({ checkExits: [[1]] });
    await w.step.start('P');
    const first = await w.step.finish();
    expect(first.isError).toBe(false);
    expect(first.text).toContain('Fix pass 1 of 1');
    expect(first.text).toContain('not instructions');
    expect(first.text).toContain('check npm test');
    // Still running: the implementer may work again, and no code commit yet.
    expect(w.step.view()).toMatchObject({ state: 'running', fixPassesUsed: 1 });
    expect(w.commits).toHaveLength(1);
    expect(w.step.implementerCall()).toBeUndefined();
    const second = await w.step.finish();
    expect(second.text).toContain('All 1 check(s) passed');
    expect(w.step.view()).toMatchObject({ state: 'done', fixPassesUsed: 1 });
    expect(w.step.view().checks.map((c) => c.pass)).toEqual([1, 2]);
  });

  it('checks that still fail after the fix passes: the code is kept and committed, with a warning, never failed', async () => {
    const w = world({ choice: { ...CHOICE, fixPasses: 0 }, checkExits: [[2]] });
    await w.step.start('P');
    const done = await w.step.finish();
    expect(done.isError).toBe(false);
    expect(done.text).toContain('Warning: 1 of 1 check(s) still fail');
    expect(w.step.view()).toMatchObject({ state: 'done', warning: 'checksFailed', codeCommit: 'c2' });
  });

  it('past the minutes, the implementer gets nothing; no fix pass then; the checks still run', async () => {
    const w = world({ checkExits: [[1]], bounds: { maxMinutes: 5, maxToolCalls: 150 } });
    await w.step.start('P');
    expect(w.step.implementerCall()).toBeUndefined();
    w.clock.ms += 5 * 60_000 + 1;
    expect(w.step.implementerCall()).toContain('time of the implement step ran out');
    expect(w.step.implementerCall()).toContain('ran out');
    expect(w.step.view().limit).toBe('time');
    const done = await w.step.finish();
    expect(done.text).toContain('stopped at a limit (time)');
    expect(w.step.view()).toMatchObject({ state: 'done', warning: 'checksFailed', fixPassesUsed: 0 });
  });

  it('past the tool calls, the implementer gets nothing', async () => {
    const w = world({ bounds: { maxMinutes: 30, maxToolCalls: 20 } });
    await w.step.start('P');
    for (let i = 0; i < 20; i += 1) expect(w.step.implementerCall()).toBeUndefined();
    expect(w.step.implementerCall()).toContain('all the tool calls');
    expect(w.step.view()).toMatchObject({ limit: 'toolCalls', toolCalls: 20 });
  });

  it('nothing for the implementer before the start, while the checks run, or after the end', async () => {
    const w = world();
    expect(w.step.implementerCall()).toContain('not running');
    await w.step.start('P');
    await w.step.finish();
    expect(w.step.implementerCall()).toContain('not running');
  });

  it('plan usage at or above the thresholds, or unread: the step does not start and nothing is committed', async () => {
    const over = world({ usage: { go: false, reason: 'usage', fiveHour: 91, sevenDay: 40 } });
    expect((await over.step.start('P')).text).toContain('at or above the thresholds');
    expect(over.step.view()).toMatchObject({ state: 'notStarted', reason: 'usage', usage: { fiveHour: 91, sevenDay: 40 } });
    const unread = world({ usage: { go: false, reason: 'usageUnread' } });
    expect((await unread.step.start('P')).text).toContain('could not be read');
    const throws = world({ usage: 'throws' });
    expect((await throws.step.start('P')).isError).toBe(true);
    expect(throws.step.view().reason).toBe('usageUnread');
    for (const w of [over, unread, throws]) expect(w.commits).toEqual([]);
    const fine = world({ usage: { go: true } });
    expect((await fine.step.start('P')).isError).toBe(false);
  });
});

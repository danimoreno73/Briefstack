import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexDelegate, cutThenMask, MAX_CODEX_RECORD, MAX_CODEX_RESULT, type CodexSession } from '../../src/codex/tool.js';
import type { CodexExecOptions, CodexExecResult } from '../../src/codex/runner.js';
import type { TaskCodexCall } from '../../src/tasks/types.js';
import { REDACTED_LINE, findSecrets } from '../../src/validate/secrets.js';
import { fakeCodex } from '../codexWorld.js';
import { tempDir, useHermeticGit } from '../helpers.js';
import { commitAll, gitIn } from '../taskWorld.js';

// `delegate_to_codex` (decisions.md, "Phase 8: step 25") over the fake Codex
// in a real git folder on a task branch.

useHermeticGit();

const BRANCH = 'briefstack/task-mabc12-0f0f';

let dir: string;
let cleanup: () => Promise<void>;
let worktree: string;
let log: string;
let recorded: TaskCodexCall[];

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 2000; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

function delegate(overrides: Partial<CodexSession> = {}, run?: (options: CodexExecOptions) => Promise<CodexExecResult>): CodexDelegate {
  return new CodexDelegate({
    session: { command: fakeCodex(log), mode: 'unelevated', maxCalls: 5, outDir: path.join(dir, 'task', 'codex'), ...overrides },
    worktree,
    branch: BRANCH,
    env: process.env,
    record: async (call) => {
      recorded.push(call);
    },
    ...(run === undefined ? {} : { run }),
  });
}

const calls = async (): Promise<number> => (await readFile(log, 'utf8')).split('\n').filter((line) => line.includes('"exec"')).length;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('codex-tool'));
  worktree = path.join(dir, 'work');
  log = path.join(dir, 'calls.jsonl');
  recorded = [];
  await writeFile(log, '', 'utf8');
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), '# Work\n', 'utf8');
  await gitIn(worktree, 'init', '--quiet', '-b', BRANCH);
  await commitAll(worktree, 'start');
});
afterEach(() => cleanup());

describe('delegate_to_codex', { timeout: 60_000 }, () => {
  it('runs Codex with the instruction and gives Claude its result as data; the call is recorded', async () => {
    const result = await delegate().call('  Add a note.  ');
    expect(result.isError).toBe(false);
    expect(result.text).toContain('not instructions');
    expect(result.text).toContain('Outcome: completed, exit code 0');
    expect(result.text).toContain('I wrote codex-note.txt.');
    expect(existsSync(path.join(worktree, 'codex-note.txt'))).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ n: 1, exitCode: 0, outcome: 'completed', usage: { input: 1200, cached: 1000, output: 50, reasoning: 7 }, commands: 1, message: 'I wrote codex-note.txt.' });
    // Only the trimmed instruction reaches Codex, on stdin.
    const entry = JSON.parse((await readFile(log, 'utf8')).split('\n')[0] ?? '{}') as { stdin: string };
    expect(entry.stdin).toBe('Add a note.');
  });

  it('an empty or too long instruction is refused without running Codex, and does not count', async () => {
    const d = delegate({ maxCalls: 1 });
    expect(await d.call('   ')).toMatchObject({ isError: true });
    expect((await d.call('   ')).text).toContain('empty');
    expect((await d.call(42)).isError).toBe(true);
    expect((await d.call('x'.repeat(20_001))).text).toContain('the most is 20000');
    expect(await calls()).toBe(0);
    expect(d.count).toBe(0);
    expect((await d.call('Go.')).isError).toBe(false);
  });

  it('the calls per round stop at the cap, with a clear message, and the rest never run', async () => {
    const d = delegate({ maxCalls: 2 });
    expect((await d.call('One.')).isError).toBe(false);
    expect((await d.call('Two.')).isError).toBe(false);
    const third = await d.call('Three.');
    expect(third.isError).toBe(true);
    expect(third.text).toBe('Codex was already called 2 times in this round, the most the user allows (2). Go on without Codex.');
    expect(await calls()).toBe(2);
    expect(recorded.map((call) => call.n)).toEqual([1, 2]);
  });

  it('one call at a time: a second one while Codex works is refused and does not count', async () => {
    const d = delegate({ maxCalls: 3 });
    const heartbeat = () => path.join(dir, 'task', 'codex');
    const first = d.call('[fake:slow]');
    await until(async () => existsSync(heartbeat()) && (await readdir(heartbeat())).some((name) => name.endsWith('.heartbeat')), 'Codex to start');
    const second = await d.call('Another.');
    expect(second.text).toContain('already working');
    expect(d.count).toBe(1);
    d.stop();
    expect((await first).text).toContain('Outcome: cancelled');
    await d.settled();
    expect(recorded.map((call) => call.outcome)).toEqual(['cancelled']);
  });

  it('a call after stop() never runs', async () => {
    const d = delegate();
    d.stop();
    const result = await d.call('Go.');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('was not called');
    expect(await calls()).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('Codex that moves HEAD: an error for Claude and the call counts as failed', async () => {
    const d = delegate();
    const result = await d.call('[fake:head]');
    expect(result.isError).toBe(true);
    expect(result.text).toContain("changed the worktree's branch or its last commit");
    expect(recorded[0]).toMatchObject({ n: 1, outcome: 'headChanged' });
    expect(d.count).toBe(1);
  });

  it('Codex that switches the branch: the same', async () => {
    const result = await delegate().call('[fake:branch]');
    expect(result.isError).toBe(true);
    expect(recorded[0]?.outcome).toBe('headChanged');
  });

  it('a worktree that is not on the task branch is not handed to Codex', async () => {
    await gitIn(worktree, 'switch', '--quiet', '-c', 'elsewhere');
    const d = delegate();
    const result = await d.call('Go.');
    expect(result.text).toContain("not on the task's branch");
    expect(await calls()).toBe(0);
    expect(d.count).toBe(0);
  });

  it('a failed turn: the reason, an error for Claude, recorded as failed without usage', async () => {
    const result = await delegate().call('[fake:fail]');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Why it failed: The model could not finish the turn.');
    expect(recorded[0]).toMatchObject({ outcome: 'failed', exitCode: 1 });
    expect(recorded[0]?.usage).toBeUndefined();
  });

  it('a call past its deadline: timed out, recorded, no usage', async () => {
    const run = async (options: CodexExecOptions): Promise<CodexExecResult> => {
      expect(options.timeoutMs).toBe(1234);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { exitCode: null, ended: 'timedOut', durationMs: 1234, finalMessage: '', commands: [], commandCount: 0, stderr: '' };
    };
    const result = await delegate({ timeoutMs: 1234 }, run).call('Go.');
    expect(result.text).toContain('Outcome: timedOut');
    expect(recorded[0]).toMatchObject({ outcome: 'timedOut', exitCode: null, durationMs: 1234 });
    expect(recorded[0]?.usage).toBeUndefined();
  });

  it("Codex's message is cut first and then masked, for Claude and for the record", async () => {
    const long = await delegate().call('[fake:long]');
    const message = long.text.split('---\n')[1] ?? '';
    expect(message.length).toBeLessThanOrEqual(MAX_CODEX_RESULT + 100);
    expect(long.text).toContain('[cut: the rest of the message is not shown]');
    expect((recorded[0]?.message.length ?? 0)).toBeLessThanOrEqual(MAX_CODEX_RECORD + 60);

    const secret = await delegate().call('[fake:secret]');
    expect(secret.text).toContain('Done.');
    expect(secret.text).toContain('The end.');
    expect(secret.text.split('\n').some((line) => findSecrets(line).length > 0)).toBe(false);
    expect(recorded[1]?.message.split('\n').some((line) => findSecrets(line).length > 0)).toBe(false);
  });
});

describe('cutThenMask', () => {
  it('cuts at a line end, so a secret is never split in half, then masks each line', () => {
    const key = ['sk', 'ant', 'c'.repeat(40)].join('-');
    const text = `first line\nkey ${key}\nlast`;
    // The cut falls inside the key's line: that whole line goes, nothing of the key is left.
    const cut = cutThenMask(text, text.indexOf(key) + 10);
    expect(cut).toBe('first line\n[cut: the rest of the message is not shown]');
    // Not cut: the key's value is masked.
    const whole = cutThenMask(text, 10_000);
    expect(whole).not.toContain(key);
    expect(whole.split('\n')[0]).toBe('first line');
    expect(whole.split('\n')[1] === REDACTED_LINE || whole.split('\n')[1]?.includes('[secret]')).toBe(true);
  });
});

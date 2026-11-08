import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findCodex, type CodexCommand } from '../../src/codex/command.js';
import { codexEnvironment } from '../../src/codex/env.js';
import { CodexEventReader } from '../../src/codex/events.js';
import { codexExecArgs, runCodexExec, runCodexProcess, type Timer } from '../../src/codex/runner.js';
import { fakeCodex } from '../codexWorld.js';
import { tempDir } from '../helpers.js';

// The Codex runner (decisions.md, "Phase 8: step 25") over the fake Codex in
// tests/fixtures/codex: no real Codex, no model, no network.

let dir: string;
let cleanup: () => Promise<void>;
let worktree: string;
let log: string;

const fake = (scenario?: string): CodexCommand => fakeCodex(log, scenario);
const logged = async (): Promise<{ argv: string[]; cwd: string; stdin?: string }[]> =>
  (await readFile(log, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; stdin?: string });

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 2000; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A deadline the test fires itself. */
function manualTimer(): { timer: Timer; armed: number[]; fire: () => void } {
  const armed: number[] = [];
  let fire: (() => void) | undefined;
  return {
    armed,
    timer: (ms, callback) => {
      armed.push(ms);
      fire = callback;
      return () => {
        fire = undefined;
      };
    },
    fire: () => fire?.(),
  };
}

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('codex-runner'));
  worktree = path.join(dir, 'task folder', 'work');
  log = path.join(dir, 'calls.jsonl');
  await writeFile(log, '', 'utf8');
  await mkdir(worktree, { recursive: true });
});
afterEach(() => cleanup());

describe('findCodex', () => {
  it('on Windows, runs the npm launcher with this Node, never codex.cmd', () => {
    const prefix = 'C:\\Users\\u\\AppData\\Roaming\\npm';
    const files = new Set([`${prefix}\\codex.cmd`, `${prefix}\\node_modules\\@openai\\codex\\bin\\codex.js`]);
    const found = findCodex({ env: { Path: `C:\\Windows;${prefix}` }, platform: 'win32', exists: (file) => files.has(file), execPath: 'C:\\node\\node.exe' });
    expect(found).toEqual({ file: 'C:\\node\\node.exe', prefix: [`${prefix}\\node_modules\\@openai\\codex\\bin\\codex.js`] });
  });

  it('on Windows, a codex.cmd without the launcher next to it is not Codex', () => {
    const prefix = 'C:\\tools';
    expect(findCodex({ env: { PATH: prefix }, platform: 'win32', exists: (file) => file === `${prefix}\\codex.cmd` })).toBeUndefined();
  });

  it('elsewhere, codex from the PATH by its full path; nothing on the PATH is undefined', () => {
    expect(findCodex({ env: { PATH: '/usr/bin:/opt/codex/bin' }, platform: 'linux', exists: (file) => file === '/opt/codex/bin/codex' })).toEqual({ file: '/opt/codex/bin/codex', prefix: [] });
    expect(findCodex({ env: {}, platform: 'darwin', exists: () => true })).toBeUndefined();
    expect(findCodex({ env: { PATH: 'relative/bin' }, platform: 'linux', exists: () => true })).toBeUndefined();
  });
});

describe('codexEnvironment', () => {
  it('leaves out credentials and every variable of ours, Claude Code, GitHub and CODEX_HOME; keeps the rest', () => {
    const { env, removed } = codexEnvironment({
      PATH: '/bin',
      HOME: '/home/u',
      LANG: 'es_ES.UTF-8',
      GIT_CONFIG_GLOBAL: '/x',
      OPENAI_API_KEY: 'a',
      NPM_TOKEN: 'b',
      DB_PASSWORD: 'c',
      AWS_SECRET_ACCESS_KEY: 'd',
      GCP_CREDENTIALS: 'e',
      ANTHROPIC_BASE_URL: 'f',
      CLAUDE_CODE_ENTRYPOINT: 'g',
      claudecode: 'h',
      BRIEFSTACK_HOME: 'i',
      GH_CONFIG_DIR: 'j',
      GITHUB_ACTIONS: 'k',
      CODEX_HOME: 'l',
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', LANG: 'es_ES.UTF-8', GIT_CONFIG_GLOBAL: '/x' });
    expect(removed).toEqual(
      ['ANTHROPIC_BASE_URL', 'AWS_SECRET_ACCESS_KEY', 'BRIEFSTACK_HOME', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'DB_PASSWORD', 'GCP_CREDENTIALS', 'GH_CONFIG_DIR', 'GITHUB_ACTIONS', 'NPM_TOKEN', 'OPENAI_API_KEY', 'claudecode'].sort(),
    );
  });
});

describe('codexExecArgs', () => {
  it('is exactly the measured call; the mode only on Windows', () => {
    expect(codexExecArgs({ worktree: 'W', outFile: 'O', mode: 'unelevated', platform: 'win32' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--ephemeral',
      '-c',
      'approval_policy="never"',
      '-c',
      'windows.sandbox="unelevated"',
      '-C',
      'W',
      '-o',
      'O',
      '-',
    ]);
    expect(codexExecArgs({ worktree: 'W', outFile: 'O', mode: 'elevated', platform: 'linux' })).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--ephemeral', '-c', 'approval_policy="never"', '-C', 'W', '-o', 'O', '-']);
  });
});

describe('CodexEventReader', () => {
  it('reads the events in chunks split anywhere: thread, commands, the last message, usage', () => {
    const lines = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls', aggregated_output: 'a\nb', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'false', exit_code: 1, status: 'failed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'last' } },
      { type: 'turn.completed', usage: { input_tokens: 32241, cached_input_tokens: 28160, cache_write_input_tokens: 0, output_tokens: 97, reasoning_output_tokens: 3 } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const reader = new CodexEventReader();
    for (let i = 0; i < lines.length; i += 7) reader.push(lines.slice(i, i + 7));
    expect(reader.end()).toEqual({
      threadId: 't-1',
      commands: [
        { command: 'ls', exitCode: 0 },
        { command: 'false', exitCode: 1 },
      ],
      commandCount: 2,
      lastMessage: 'last',
      usage: { input: 32241, cached: 28160, output: 97, reasoning: 3 },
      unreadLines: 0,
    });
  });

  it('a failed turn, an error event and lines that are not JSON', () => {
    const reader = new CodexEventReader();
    reader.push('noise\n{"type":"turn.failed","error":{"message":"quota"}}\n[1,2]\n');
    expect(reader.end()).toMatchObject({ failure: 'quota', unreadLines: 2, commandCount: 0 });
    const other = new CodexEventReader();
    other.push('{"type":"error","message":"stream closed"}');
    expect(other.end()).toMatchObject({ failure: 'stream closed' });
  });
});

describe('runCodexExec over the fake Codex', { timeout: 60_000 }, () => {
  it('runs the exact arguments in the worktree, the instruction on stdin, and reads the events, the -o file and the exit code', async () => {
    const outFile = path.join(dir, 'out', 'last.txt');
    const result = await runCodexExec({ command: fake(), worktree, instruction: 'Add a note.', mode: 'elevated', outFile, env: codexEnvironment(process.env).env, timeoutMs: 60_000 });
    expect(result).toMatchObject({ exitCode: 0, ended: 'exited', threadId: '0199a000-fake-7000-8000-000000000001', finalMessage: 'I wrote codex-note.txt.', commandCount: 1, usage: { input: 1200, cached: 1000, output: 50, reasoning: 7 } });
    expect(result.commands).toEqual([{ command: 'Set-Content codex-note.txt', exitCode: 0 }]);
    expect(result.failure).toBeUndefined();
    expect(await readFile(path.join(worktree, 'codex-note.txt'), 'utf8')).toBe('Written by the fake Codex.\n');
    // The -o file is read and removed: nothing of it stays.
    expect(existsSync(outFile)).toBe(false);
    const [call] = await logged();
    expect(call?.argv).toEqual(codexExecArgs({ worktree, outFile, mode: 'elevated' }));
    expect(call?.stdin).toBe('Add a note.');
    expect(path.resolve(call?.cwd ?? '')).toBe(path.resolve(worktree));
  });

  it('Codex gets the cleaned environment: no credential or variable of ours', async () => {
    const env = { ...process.env, ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', BRIEFSTACK_HOME: 'z', GH_TOKEN: 'w', CODEX_HOME: dir, MY_SECRET: 's' };
    const result = await runCodexExec({ command: fake(), worktree, instruction: '[fake:env]', outFile: path.join(dir, 'o.txt'), env: codexEnvironment(env).env, timeoutMs: 60_000 });
    expect(result.finalMessage).toBe('ENV:');
  });

  it('a failed turn: its exit code and reason, no usage', async () => {
    const result = await runCodexExec({ command: fake(), worktree, instruction: '[fake:fail]', outFile: path.join(dir, 'o.txt'), env: codexEnvironment(process.env).env, timeoutMs: 60_000 });
    expect(result).toMatchObject({ exitCode: 1, ended: 'exited', failure: 'The model could not finish the turn.', finalMessage: '' });
    expect(result.usage).toBeUndefined();
  });

  it('without an -o file the last agent message stands in; noise is skipped', async () => {
    const result = await runCodexExec({ command: fake(), worktree, instruction: '[fake:noout] [fake:noisy]', outFile: path.join(dir, 'o.txt'), env: codexEnvironment(process.env).env, timeoutMs: 60_000 });
    expect(result).toMatchObject({ exitCode: 0, finalMessage: 'I wrote codex-note.txt.' });
  });

  it('past its deadline the whole process tree is ended, and the call reports no usage', async () => {
    const outFile = path.join(dir, 'o.txt');
    const heartbeat = `${outFile}.heartbeat`;
    const clock = manualTimer();
    const running = runCodexExec({ command: fake(), worktree, instruction: '[fake:slow]', outFile, env: codexEnvironment(process.env).env, timeoutMs: 123_000, timer: clock.timer });
    await until(() => existsSync(heartbeat), 'the child of the fake Codex to beat');
    const child = (JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number }).pid;
    expect(alive(child)).toBe(true);
    expect(clock.armed).toEqual([123_000]);
    clock.fire();
    const result = await running;
    expect(result.ended).toBe('timedOut');
    expect(result.usage).toBeUndefined();
    await until(() => !alive(child), 'the child to be gone');
  });

  it('an abort (cancel, stop, server stop) ends the whole tree too', async () => {
    const outFile = path.join(dir, 'o.txt');
    const heartbeat = `${outFile}.heartbeat`;
    const abort = new AbortController();
    const running = runCodexExec({ command: fake(), worktree, instruction: '[fake:slow]', outFile, env: codexEnvironment(process.env).env, timeoutMs: 600_000, signal: abort.signal, timer: manualTimer().timer });
    await until(() => existsSync(heartbeat), 'the child of the fake Codex to beat');
    const child = (JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number }).pid;
    abort.abort();
    const result = await running;
    expect(result.ended).toBe('cancelled');
    expect(result.usage).toBeUndefined();
    await until(() => !alive(child), 'the child to be gone');
  });

  it('an abort before the start runs nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await runCodexExec({ command: fake(), worktree, instruction: 'x', outFile: path.join(dir, 'o.txt'), env: {}, timeoutMs: 60_000, signal: abort.signal });
    expect(result.ended).toBe('cancelled');
    expect(await logged()).toEqual([]);
  });

  it('a program that does not exist never started', async () => {
    const result = await runCodexProcess({ command: { file: path.join(dir, 'no-such-codex'), prefix: [] }, args: ['--version'], cwd: dir, env: codexEnvironment(process.env).env, timeoutMs: 60_000 });
    expect(result).toMatchObject({ ended: 'notStarted', exitCode: null });
  });
});

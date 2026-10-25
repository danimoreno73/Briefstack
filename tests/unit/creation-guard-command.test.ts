import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemPathEnv } from '../../src/config/paths.js';
import { evaluateToolUse } from '../../src/creation/guard.js';
import {
  GUARD_COMMAND_TIMEOUT_S,
  decideToolUse,
  guardCommandLine,
  guardCommandSettings,
  writeGuardRulesSync,
  type GuardRules,
} from '../../src/creation/guardCommand.js';
import { tempDir } from '../helpers.js';

const SESSION = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';

describe('the command-hook guard', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let rulesFile: string;
  let rules: GuardRules;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('guard-command'));
    rulesFile = path.join(dir, 'runs', 'c1', 'guard.json');
    rules = {
      v: 1,
      projectsDir: path.join(dir, 'projects'),
      sessionsDir: path.join(dir, 'sessions'),
      libraryDir: path.join(dir, 'library'),
      cwd: path.join(dir, 'repo'),
      granted: [],
      cancelled: false,
    };
    for (const folder of [rules.projectsDir, rules.sessionsDir, path.join(dir, 'granted'), path.join(dir, 'outside')]) {
      await mkdir(folder, { recursive: true });
    }
    writeGuardRulesSync(rulesFile, rules);
  });
  afterEach(() => cleanup());

  const input = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: tool, tool_input: toolInput, ...extra });
  const write = (file: string) => input('Write', { file_path: file, content: 'x' });
  const decide = (stdin: string) => decideToolUse(stdin, rulesFile);

  it('writes the rules whole and reads them back', async () => {
    expect(JSON.parse(await readFile(rulesFile, 'utf8'))).toEqual(rules);
    writeGuardRulesSync(rulesFile, { ...rules, sessionId: SESSION });
    expect(JSON.parse(await readFile(rulesFile, 'utf8'))).toMatchObject({ sessionId: SESSION });
  });

  it('denies everything when the rules are missing, not valid or not JSON', async () => {
    const call = write(path.join(rules.projectsDir, 'a.txt'));
    expect(await decideToolUse(call, path.join(dir, 'missing.json'))).toMatchObject({ code: 2 });
    await writeFile(rulesFile, '{"v":1}', 'utf8');
    expect(await decide(call)).toMatchObject({ code: 2, message: expect.stringContaining('not valid') });
    await writeFile(rulesFile, 'not json', 'utf8');
    expect(await decide(call)).toMatchObject({ code: 2 });
    await writeFile(rulesFile, JSON.stringify({ ...rules, projectsDir: 'relative' }), 'utf8');
    expect(await decide(call)).toMatchObject({ code: 2 });
  });

  it('denies input it cannot read', async () => {
    expect(await decide('not json')).toMatchObject({ code: 2 });
    expect(await decide('{"tool_name":"Write"}')).toMatchObject({ code: 2 });
    expect(await decide(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SESSION }))).toMatchObject({ code: 2 });
  });

  it('lets other events and allowed calls through without a decision, and denies the rest with a reason', async () => {
    expect(await decide(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SESSION }))).toEqual({ code: 0 });
    expect(await decide(write(path.join(rules.projectsDir, 'app', 'a.txt')))).toEqual({ code: 0 });
    expect(await decide(write(path.join(rules.sessionsDir, SESSION, 'spec.json')))).toEqual({ code: 0 });
    expect(await decide(input('Bash', { command: 'npm run --silent briefstack -- paths --json' }))).toEqual({ code: 0 });
    // The hook's message is what the model reads: it must also say how to get the folder granted.
    const outside = await decide(write(path.join(dir, 'outside', 'a.txt')));
    expect(outside).toMatchObject({ code: 2, message: expect.stringContaining('Writes are only allowed') });
    expect(outside.message).toContain('`grant_directory`');
    expect(await decide(input('Bash', { command: 'echo hi > x' }))).toMatchObject({ code: 2 });
    expect(await decide(input('Monitor', { command: 'echo' }))).toMatchObject({ code: 2 });
    expect(await decide(input('WebFetch', { url: 'https://example.com' }))).toMatchObject({ code: 2 });
    expect(await decide(input('WebFetch', { url: 'https://example.com' }, { agent_id: 'a1', agent_type: 'researcher' }))).toEqual({ code: 0 });
    // Each tool call leaves a line next to the rules, with the reason only when denied and never the input.
    const lines = (await readFile(path.join(path.dirname(rulesFile), 'guard.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; decision: string; reason?: string });
    expect(lines.map((line) => `${line.tool}:${line.decision}`)).toEqual([
      'Write:none',
      'Write:none',
      'Bash:none',
      'Write:deny',
      'Bash:deny',
      'Monitor:deny',
      'WebFetch:deny',
      'WebFetch:none',
    ]);
    expect(JSON.stringify(lines)).not.toContain('example.com');
    expect(lines[3]?.reason).toContain('Writes are only allowed');
  });

  it('follows grants, a cancel and the session id from the rules', async () => {
    const granted = write(path.join(dir, 'granted', 'a.txt'));
    expect(await decide(granted)).toMatchObject({ code: 2 });
    writeGuardRulesSync(rulesFile, { ...rules, granted: [path.join(dir, 'granted')] });
    expect(await decide(granted)).toEqual({ code: 0 });
    writeGuardRulesSync(rulesFile, { ...rules, cancelled: true });
    expect(await decide(write(path.join(rules.projectsDir, 'a.txt')))).toMatchObject({ code: 2 });
    writeGuardRulesSync(rulesFile, { ...rules, sessionId: 'another-session' });
    expect(await decide(write(path.join(rules.projectsDir, 'a.txt')))).toMatchObject({ code: 2, message: expect.stringContaining('another session') });
  });

  it('denies exactly what the callback guard denies', async () => {
    await mkdir(path.join(rules.libraryDir, 'skills', 'helper', 'files'), { recursive: true });
    const ctx = {
      isOwnSession: () => true,
      sessionDir: (id: string) => path.join(rules.sessionsDir, id),
      projectsDir: rules.projectsDir,
      libraryDir: rules.libraryDir,
      cwd: rules.cwd,
      grantedDirs: () => [],
      cancelled: () => false,
      pathEnv: systemPathEnv(),
    };
    const calls: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['Write', { file_path: path.join(rules.projectsDir, 'a.txt') }, {}],
      ['Write', { file_path: path.join(dir, 'outside', 'a.txt') }, {}],
      ['Write', { file_path: 'relative.txt' }, {}],
      ['Edit', { file_path: path.join(rules.projectsDir, 'app', '.git', 'config') }, {}],
      ['Bash', { command: 'npm run --silent briefstack -- scaffold "spec.json" "/elsewhere"' }, { agent_id: 'g', agent_type: 'generator' }],
      ['Bash', { command: 'npm run --silent briefstack -- validate' }, { agent_id: 'r', agent_type: 'reviewer' }],
      ['PowerShell', { command: 'Remove-Item x' }, {}],
      ['SubagentHandback', {}, {}],
      ['SubagentHandback', {}, { agent_id: 'i', agent_type: 'interviewer' }],
      ['Read', { file_path: path.join(dir, 'outside', 'a.txt') }, {}],
      ['Read', { file_path: path.join(rules.libraryDir, 'skills', 'x', 'files', 'SKILL.md') }, { agent_id: 'g', agent_type: 'generator' }],
      ['Grep', { pattern: 'x', path: rules.libraryDir }, {}],
      ['Write', { file_path: path.join(rules.projectsDir, 'app', '.claude', 'skills', 'helper', 'SKILL.md') }, { agent_id: 'g', agent_type: 'generator' }],
      ['Write', { file_path: path.join(rules.projectsDir, 'app', '.claude', 'skills', 'own', 'SKILL.md') }, { agent_id: 'g', agent_type: 'generator' }],
      ['CronCreate', {}, {}],
    ];
    for (const [tool, toolInput, who] of calls) {
      const callback = await evaluateToolUse(ctx, { session_id: SESSION, tool_name: tool, tool_input: toolInput, ...who });
      const command = await decide(input(tool, toolInput, who));
      expect(command.code === 2, `${tool} ${JSON.stringify(toolInput)}`).toBe(callback.verdict === 'deny');
    }
    const generatorWrite = (name: string) =>
      input('Write', { file_path: path.join(rules.projectsDir, 'app', '.claude', 'skills', name, 'SKILL.md') }, { agent_id: 'g', agent_type: 'generator' });
    expect(await decide(generatorWrite('helper'))).toMatchObject({ code: 2, message: expect.stringContaining("user's library") });
    expect(await decide(generatorWrite('own'))).toEqual({ code: 0 });
  });

  it('is registered as a command hook on every tool that blocks the call when it fails', () => {
    const settings = guardCommandSettings(rulesFile);
    expect(settings.hooks.PreToolUse).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: process.execPath,
            args: expect.arrayContaining([rulesFile]) as unknown,
            onFailure: 'block',
            timeout: GUARD_COMMAND_TIMEOUT_S,
          },
        ],
      },
    ]);
    // No matcher: it runs for every tool.
    expect(settings.hooks.PreToolUse[0]).not.toHaveProperty('matcher');
  });

  describe('as a process', () => {
    const run = (stdin: string, args = guardCommandLine(rulesFile).args) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (stderr += chunk));
        child.on('exit', (code) => resolve({ code, stderr }));
        child.stdin.end(stdin);
      });

    it('exits 0 for an allowed call and 2 with the reason on stderr for a denied one', async () => {
      expect(await run(write(path.join(rules.projectsDir, 'a.txt')))).toEqual({ code: 0, stderr: '' });
      const denied = await run(write(path.join(dir, 'outside', 'a.txt')));
      expect(denied.code).toBe(2);
      expect(denied.stderr).toContain('Writes are only allowed');
    }, 30_000);

    it('exits 2 without its rules, with rules it cannot read, and with no rules argument', async () => {
      const call = write(path.join(rules.projectsDir, 'a.txt'));
      const args = guardCommandLine(rulesFile).args;
      expect((await run(call, [...args.slice(0, -1), path.join(dir, 'none.json')])).code).toBe(2);
      expect((await run(call, args.slice(0, -1))).code).toBe(2);
      expect((await run(call, [...args.slice(0, -1), 'relative.json'])).code).toBe(2);
      await writeFile(rulesFile, '{', 'utf8');
      expect((await run(call)).code).toBe(2);
    }, 30_000);
  });
});

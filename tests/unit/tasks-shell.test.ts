import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideTaskToolUse, taskGuardHooks, TASK_GUARD_TIMEOUT_S, writeTaskRulesSync, type TaskRulesFile } from '../../src/tasks/guardCommand.js';
import { approvalHash, describeCommand, TaskApprovals, type ApprovalRequest, type ShellAnswer } from '../../src/tasks/shell.js';
import { tempDir, writeTree } from '../helpers.js';

let dir: string;
let approvalsDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-shell'));
  approvalsDir = path.join(dir, 'task', 'approvals');
});

afterEach(() => cleanup());

describe('describeCommand', () => {
  it('finds separators, substitutions and redirects outside quotes, for display only', () => {
    expect(describeCommand('npm test')).toMatchObject({ compound: false, features: [], runsGit: false, redacted: false, text: 'npm test' });
    expect(describeCommand('npm test && curl https://x.invalid').features).toEqual(['and']);
    expect(describeCommand('a || b; c | d &').features.sort()).toEqual(['background', 'or', 'pipe', 'sequence']);
    expect(describeCommand('echo "$(whoami)"').features).toEqual(['substitution']);
    expect(describeCommand('echo `id`').features).toEqual(['backtick']);
    expect(describeCommand("echo 'a && b; c | d'").features).toEqual([]);
    expect(describeCommand('echo "a && b"').features).toEqual([]);
    expect(describeCommand('a\nb').features).toEqual(['newline']);
    expect(describeCommand('a\n').features).toEqual([]);
    expect(describeCommand('diff <(a) <(b)').features).toEqual(['processSubstitution']);
    expect(describeCommand('npm test > out.txt 2>&1')).toMatchObject({ features: ['redirect'], compound: false });
  });

  it('notes git commands, which run the project\'s own git hooks', () => {
    expect(describeCommand('git commit -m x').runsGit).toBe(true);
    expect(describeCommand('npm test && git push').runsGit).toBe(true);
    expect(describeCommand('echo digit').runsGit).toBe(false);
  });

  it('hides lines that look like secrets and says so', () => {
    const token = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'].join('-');
    const shown = describeCommand(`curl -H "Authorization: Bearer ${token}" https://x.invalid`);
    expect(shown.redacted).toBe(true);
    expect(shown.text).not.toContain('sk-ant');
  });
});

describe('TaskApprovals', () => {
  const asked: ApprovalRequest[] = [];
  const asking = (answers: ShellAnswer[]) => {
    asked.length = 0;
    return async (request: ApprovalRequest): Promise<ShellAnswer> => {
      asked.push(request);
      return answers.shift() ?? 'deny';
    };
  };
  const record = async (id: string) => JSON.parse(await readFile(path.join(approvalsDir, `${id}.json`), 'utf8')) as { decision: string; hash: string };

  it('asks each time for "once", and records each decision for its call', async () => {
    const approvals = new TaskApprovals(approvalsDir, asking(['once', 'once']));
    expect(await approvals.decide('toolu_1', { kind: 'shell', tool: 'Bash', key: 'npm test' })).toBe('allow');
    expect(await approvals.decide('toolu_2', { kind: 'shell', tool: 'Bash', key: 'npm test' })).toBe('allow');
    expect(asked).toHaveLength(2);
    expect(asked[0]?.display.text).toBe('npm test');
    expect(await record('toolu_1')).toEqual({ v: 1, decision: 'allow', hash: approvalHash('Bash', 'npm test') });
  });

  it('remembers "this exact command" for the task: the same tool and the whole string only', async () => {
    const approvals = new TaskApprovals(approvalsDir, asking(['task', 'deny', 'deny', 'deny', 'deny']));
    expect(await approvals.decide('t1', { kind: 'shell', tool: 'Bash', key: 'npm test' })).toBe('allow');
    expect(await approvals.decide('t2', { kind: 'shell', tool: 'Bash', key: 'npm test' })).toBe('allow');
    expect(asked).toHaveLength(1);
    // Not a prefix, not a compound command that starts with it, not another spelling, not another tool.
    for (const [id, tool, key] of [
      ['t3', 'Bash', 'npm test && curl https://x.invalid'],
      ['t4', 'Bash', 'npm  test'],
      ['t5', 'Bash', 'npm test '],
      ['t6', 'PowerShell', 'npm test'],
    ] as const) {
      expect(await approvals.decide(id, { kind: 'shell', tool, key }), key).toBe('deny');
    }
    expect(asked).toHaveLength(5);
    expect(approvals.allowedForTask('Bash', 'npm test')).toBe(true);
    expect((await record('t3')).decision).toBe('deny');
  });

  it('denies, forgets a call\'s record, and keeps nothing after the task', async () => {
    const approvals = new TaskApprovals(approvalsDir, asking(['deny', 'task']));
    expect(await approvals.decide('t1', { kind: 'web', tool: 'WebFetch', key: 'https://x.invalid' })).toBe('deny');
    expect(await approvals.decide('t2', { kind: 'shell', tool: 'Bash', key: 'ls' })).toBe('allow');
    await approvals.forget('t1');
    expect(await readdir(approvalsDir)).toEqual(['t2.json']);
    await approvals.clear();
    expect(await readdir(approvalsDir)).toEqual([]);
    expect(approvals.allowedForTask('Bash', 'ls')).toBe(false);
  });

  it('denies without asking a call with no usable id', async () => {
    const approvals = new TaskApprovals(approvalsDir, asking(['once']));
    expect(await approvals.decide(undefined, { kind: 'shell', tool: 'Bash', key: 'ls' })).toBe('deny');
    expect(await approvals.decide('../x', { kind: 'shell', tool: 'Bash', key: 'ls' })).toBe('deny');
    expect(asked).toHaveLength(0);
  });
});

describe('the command-hook guard of a task', () => {
  let rulesFile: string;
  let worktree: string;
  const rules = (overrides: Partial<TaskRulesFile> = {}): TaskRulesFile => ({ v: 1, worktree, skills: ['deploy'], approvalsDir, serverPid: process.pid, cancelled: false, ...overrides });
  const hookInput = (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name, tool_input, tool_use_id: 'toolu_9', ...extra });
  const fast = { sleep: async () => undefined };

  beforeEach(async () => {
    worktree = path.join(dir, 'task', 'work');
    await writeTree(worktree, { 'a.txt': 'a\n' });
    rulesFile = path.join(dir, 'task', 'guard.json');
    writeTaskRulesSync(rulesFile, rules());
  });

  it('applies the path rules: allows inside, denies outside', async () => {
    expect(await decideTaskToolUse(hookInput('Read', { file_path: path.join(worktree, 'a.txt') }), rulesFile)).toEqual({ code: 0 });
    expect(await decideTaskToolUse(hookInput('Read', { file_path: rulesFile }), rulesFile)).toMatchObject({ code: 2 });
    expect(await decideTaskToolUse(hookInput('Skill', { skill: 'loop' }), rulesFile)).toMatchObject({ code: 2 });
    expect(await decideTaskToolUse(JSON.stringify({ hook_event_name: 'PostToolUse' }), rulesFile)).toEqual({ code: 0 });
  });

  it('lets a shell command through only with the server\'s record of an allow for that call and that command', async () => {
    await writeTree(approvalsDir, { 'toolu_9.json': JSON.stringify({ v: 1, decision: 'allow', hash: approvalHash('Bash', 'npm test') }) });
    expect(await decideTaskToolUse(hookInput('Bash', { command: 'npm test' }), rulesFile, fast)).toEqual({ code: 0 });
    // The record is for another command.
    expect(await decideTaskToolUse(hookInput('Bash', { command: 'npm test && rm -rf x' }), rulesFile, fast)).toMatchObject({ code: 2 });
    // The record says deny.
    await writeFile(path.join(approvalsDir, 'toolu_9.json'), JSON.stringify({ v: 1, decision: 'deny', hash: approvalHash('Bash', 'npm test') }), 'utf8');
    expect(await decideTaskToolUse(hookInput('Bash', { command: 'npm test' }), rulesFile, fast)).toMatchObject({ code: 2 });
  });

  it('waits for the record, and denies when the server is gone or no decision comes in time', async () => {
    let polls = 0;
    const later = decideTaskToolUse(hookInput('Bash', { command: 'ls' }), rulesFile, {
      sleep: async () => {
        polls += 1;
        if (polls === 3) await writeTree(approvalsDir, { 'toolu_9.json': JSON.stringify({ v: 1, decision: 'allow', hash: approvalHash('Bash', 'ls') }) });
      },
    });
    expect(await later).toEqual({ code: 0 });
    expect(polls).toBe(3);

    expect(await decideTaskToolUse(hookInput('Bash', { command: 'ls' }, { tool_use_id: 'toolu_x' }), rulesFile, { ...fast, alive: () => false })).toMatchObject({
      code: 2,
      message: expect.stringContaining('not running'),
    });
    let clock = 0;
    expect(
      await decideTaskToolUse(hookInput('Bash', { command: 'ls' }, { tool_use_id: 'toolu_y' }), rulesFile, { sleep: async () => void (clock += 1000), now: () => clock, deadline: 5000 }),
    ).toMatchObject({ code: 2, message: expect.stringContaining('in time') });
    expect(await decideTaskToolUse(hookInput('Bash', { command: 'ls' }, { tool_use_id: undefined }), rulesFile, fast)).toMatchObject({ code: 2 });
  });

  it('denies everything when cancelled, from another session, or without valid rules', async () => {
    writeTaskRulesSync(rulesFile, rules({ sessionIds: ['s2'] }));
    expect(await decideTaskToolUse(hookInput('Read', { file_path: path.join(worktree, 'a.txt') }), rulesFile)).toMatchObject({ code: 2 });
    writeTaskRulesSync(rulesFile, rules({ cancelled: true }));
    expect(await decideTaskToolUse(hookInput('Read', { file_path: path.join(worktree, 'a.txt') }), rulesFile)).toMatchObject({ code: 2 });
    await writeFile(rulesFile, '{ broken', 'utf8');
    expect(await decideTaskToolUse(hookInput('Read', { file_path: path.join(worktree, 'a.txt') }), rulesFile)).toMatchObject({ code: 2 });
    expect(await decideTaskToolUse('not json', path.join(dir, 'missing.json'))).toMatchObject({ code: 2 });
  });

  it('is registered on every tool, failing closed, with a timeout over the dialog\'s', () => {
    const hooks = taskGuardHooks(rulesFile) as { PreToolUse: [{ matcher?: string; hooks: [{ type: string; command: string; args: string[]; onFailure: string; timeout: number }] }] };
    const entry = hooks.PreToolUse[0];
    expect(entry.matcher).toBeUndefined();
    expect(entry.hooks[0]).toMatchObject({ type: 'command', command: process.execPath, onFailure: 'block', timeout: TASK_GUARD_TIMEOUT_S });
    expect(entry.hooks[0].args.at(-1)).toBe(rulesFile);
  });
});

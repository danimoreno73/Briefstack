import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { HookCallback, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackedSpawn } from '../../src/creation/processTree.js';
import type { QuestionRequest, QuestionResult } from '../../src/creation/types.js';
import { claudeTokens, claudeUsageOf, UNATTENDED_DENIED, UNATTENDED_QUESTION, type TaskRunnerEvent, type TaskRunnerStartOptions } from '../../src/tasks/runner.js';
import { TaskSdkRunner } from '../../src/tasks/sdkRunner.js';
import { TaskApprovals, type ApprovalRequest, type ShellAnswer } from '../../src/tasks/shell.js';
import { tempDir, writeTree } from '../helpers.js';
import type { ReserveProvider } from '../../src/providers/config.js';

const SESSION = '7a1b2c3d-0000-4a5b-9c8d-123456789abc';

class FakeQuery {
  readonly messages: SDKMessage[] = [];
  closed = false;
  private waiting: ((result: IteratorResult<SDKMessage, void>) => void) | undefined;

  push(message: Record<string, unknown>): void {
    const item = message as unknown as SDKMessage;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else this.messages.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
    return {
      next: () => {
        const item = this.messages.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

const noTree = (): TrackedSpawn => ({ spawn: () => { throw new Error('not used'); }, killTree: async () => undefined }) as unknown as TrackedSpawn;

let dir: string;
let worktree: string;
let cleanup: () => Promise<void>;
let fake: FakeQuery;
let options: Options | undefined;
let events: TaskRunnerEvent[];
let asked: ApprovalRequest[];
let answers: ShellAnswer[];
let questions: QuestionRequest[];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-sdk'));
  worktree = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'work');
  await writeTree(worktree, { 'a.txt': 'a\n' });
  fake = new FakeQuery();
  options = undefined;
  events = [];
  asked = [];
  answers = [];
  questions = [];
});

afterEach(() => cleanup());

// The user's own credentials, as the server's environment may hold them (built at run time: nothing secret-looking in the repo).
const USER_TOKEN = ['user', 'token', 'x'.repeat(20)].join('-');

function start(skills: string[] = [], unattended = false, provider?: ReserveProvider) {
  const runner = new TaskSdkRunner({
    pathEnv: {
      env: { PATH: 'x', ANTHROPIC_MODEL: 'opus', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SYNC_SKILLS: '1', ANTHROPIC_AUTH_TOKEN: USER_TOKEN, CLAUDE_CODE_OAUTH_TOKEN: USER_TOKEN, HTTPS_PROXY: 'http://proxy.invalid:3128' },
      homedir: dir,
      pathApi: path,
      caseInsensitive: process.platform !== 'linux',
    },
    query: (params) => {
      options = params.options;
      return fake as unknown as Query;
    },
    findExecutable: () => '/bin/claude',
    tracked: noTree,
  });
  const approvalsDir = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'approvals');
  const start: TaskRunnerStartOptions = {
    taskId: 'abc123-0f0f',
    project: 'garden',
    round: 1,
    prompt: 'Do the task.',
    worktree,
    model: 'sonnet',
    effort: 'low',
    sessionsDir: path.join(dir, 'home', 'sessions'),
    skills,
    restrictions: { deny: ['Read(./.env)'], ask: [] },
    rulesFile: path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json'),
    approvalsDir,
    approvals: new TaskApprovals(approvalsDir, async (request) => {
      asked.push(request);
      return answers.shift() ?? 'deny';
    }),
    ...(unattended ? { unattended: true as const } : {}),
    ...(provider === undefined ? {} : { provider }),
    io: {
      askQuestions: async (request): Promise<QuestionResult> => {
        questions.push(request);
        return { decision: 'answer', answers: { 'Which?': 'A' } };
      },
      emit: (event) => events.push(event),
    },
  };
  return { handle: runner.start(start), start };
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const hook = (event: string): HookCallback => {
  const matcher = (options?.hooks as Record<string, { hooks: HookCallback[] }[]>)[event]?.[0];
  return matcher?.hooks[0] as HookCallback;
};
const pre = (tool_name: string, tool_input: Record<string, unknown>, tool_use_id = 'toolu_1', extra: Record<string, unknown> = {}) =>
  hook('PreToolUse')({ hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '', cwd: worktree, tool_name, tool_input, tool_use_id, ...extra } as never, tool_use_id, { signal: new AbortController().signal });
const decisionOf = (output: unknown) => (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

describe('TaskSdkRunner: the session it starts', () => {
  it('runs in the worktree in auto mode with the work model, the closed tools, the project\'s skills and the task\'s settings', async () => {
    const { handle } = start(['deploy']);
    await until(() => options !== undefined, 'query');
    expect(options).toMatchObject({
      cwd: worktree,
      settingSources: ['project'],
      permissionMode: 'auto',
      model: 'sonnet',
      effort: 'low',
      skills: ['deploy'],
      strictMcpConfig: true,
      mcpServers: {},
      additionalDirectories: [],
      pathToClaudeCodeExecutable: '/bin/claude',
    });
    expect(options?.permissionMode).not.toBe('bypassPermissions');
    expect(options?.tools).toContain('Skill');
    expect(options?.tools).not.toContain('CronCreate');
    const settings = options?.settings as unknown as Record<string, unknown>;
    expect(settings).toMatchObject({ disableBundledSkills: true, disableSkillShellExecution: true, permissions: { deny: ['Read(./.env)'] } });
    expect(settings.disableAllHooks).toBeUndefined();
    expect(options?.env).toMatchObject({ CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(options?.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(options?.env?.CLAUDE_CODE_SYNC_SKILLS).toBeUndefined();
    expect((options?.hooks?.PreToolUse?.[0] as { timeout?: number }).timeout).toBe(3600);
    // The command-hook guard's rules are written before claude starts.
    const rules = JSON.parse(await readFile(path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json'), 'utf8')) as Record<string, unknown>;
    expect(rules).toMatchObject({ v: 1, worktree, skills: ['deploy'], serverPid: process.pid, cancelled: false });
    fake.close();
    await handle.done;
  });

  // Phase 12, M4: a reserve provider's round.
  it('on a reserve provider: its base URL, its key from its file and its models, no Anthropic credential, mode default, no effort', async () => {
    const key = ['prov', 'key', 'k'.repeat(24)].join('-');
    const keyFile = path.join(dir, 'provider.key');
    await writeTree(dir, { 'provider.key': `${key}\n` });
    const provider: ReserveProvider = { name: 'deepseek', baseUrl: 'https://api.deepseek.invalid/anthropic', model: 'big-model', smallModel: 'small-model', keyFile };
    const { handle } = start([], true, provider);
    await until(() => options !== undefined, 'query');
    expect(options).toMatchObject({ permissionMode: 'default', model: 'big-model' });
    expect(options?.effort).toBeUndefined();
    expect(options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.invalid/anthropic',
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'big-model',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'big-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small-model',
      CLAUDE_CODE_SUBAGENT_MODEL: 'small-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      CLAUDE_CODE_DISABLE_CRON: '1',
    });
    expect(options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(options?.env)).not.toContain(USER_TOKEN);
    // The key is in no event the round emitted.
    expect(JSON.stringify(events)).not.toContain(key);
    fake.close();
    await handle.done;
  });

  it('on Claude: the user\'s own credentials pass as before, and no provider variable is set', async () => {
    const { handle } = start([], true);
    await until(() => options !== undefined, 'query');
    expect(options).toMatchObject({ permissionMode: 'auto', model: 'sonnet', effort: 'low' });
    expect(options?.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: USER_TOKEN, CLAUDE_CODE_OAUTH_TOKEN: USER_TOKEN });
    expect(options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    fake.close();
    await handle.done;
  });

  it('on a reserve provider whose key file is missing: the round fails before any session, naming the file', async () => {
    const provider: ReserveProvider = { name: 'kimi', baseUrl: 'https://api.kimi.invalid/anthropic', model: 'm', keyFile: path.join(dir, 'none.key') };
    const { handle } = start([], true, provider);
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(options).toBeUndefined();
  });

  it('offers no Skill tool to a project without skills', async () => {
    const { handle } = start([]);
    await until(() => options !== undefined, 'query');
    expect(options?.tools).not.toContain('Skill');
    expect(options?.skills).toEqual([]);
    fake.close();
    await handle.done;
  });
});

describe('TaskSdkRunner: tool calls', () => {
  it('denies outside the worktree, allows inside, and asks for a shell command with a record for the command hook', async () => {
    const { handle } = start();
    await until(() => options !== undefined, 'query');
    fake.push({ type: 'system', subtype: 'init', session_id: SESSION, tools: [] });
    expect(await handle.sessionId).toBe(SESSION);

    expect(decisionOf(await pre('Read', { file_path: path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json') }))).toBe('deny');
    expect(events.find((event) => event.kind === 'denial')).toMatchObject({ toolName: 'Read' });
    expect(decisionOf(await pre('Write', { file_path: path.join(worktree, 'b.txt'), content: 'b' }))).toBe('allow');

    answers.push('once');
    expect(decisionOf(await pre('Bash', { command: 'npm test' }, 'toolu_7'))).toBe('allow');
    expect(asked[0]).toMatchObject({ kind: 'shell', tool: 'Bash', key: 'npm test', display: { text: 'npm test' } });
    const approvals = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'approvals');
    expect(await readdir(approvals)).toEqual(['toolu_7.json']);
    // canUseTool after the hook (a project ask rule): no second dialog for the same call.
    const allowed = await options?.canUseTool?.('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'toolu_7' } as never);
    expect(allowed).toMatchObject({ behavior: 'allow' });
    expect(asked).toHaveLength(1);
    // The call ran: its record goes.
    await hook('PostToolUse')({ hook_event_name: 'PostToolUse', session_id: SESSION, transcript_path: '', cwd: worktree, tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'toolu_7' } as never, 'toolu_7', { signal: new AbortController().signal });
    expect(await readdir(approvals)).toEqual([]);

    answers.push('deny');
    expect(decisionOf(await pre('Bash', { command: 'rm -rf /' }, 'toolu_8'))).toBe('deny');
    expect(decisionOf(await pre('Skill', { skill: 'loop' }, 'toolu_9'))).toBe('deny');

    fake.close();
    await handle.done;
    const lines = await readFile(path.join(dir, 'home', 'sessions', SESSION, 'events.jsonl'), 'utf8');
    expect(lines).toContain('"type":"session.started"');
    expect(lines).toContain('"root":"work","path":"b.txt"');
    expect(lines).not.toContain('npm test');
    expect(lines).not.toContain('rm -rf');
  });

  it('passes questions to the user, ends its turn with the summary, and ends the round on finish', async () => {
    const { handle } = start();
    await until(() => options !== undefined, 'query');
    fake.push({ type: 'system', subtype: 'init', session_id: SESSION, tools: [] });
    const answered = await options?.canUseTool?.('AskUserQuestion', { questions: [{ question: 'Which?', header: 'W', options: [{ label: 'A', description: '' }], multiSelect: false }] }, { signal: new AbortController().signal } as never);
    expect(answered).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which?': 'A' } } });
    expect(questions).toHaveLength(1);
    fake.push({ type: 'result', subtype: 'success', result: 'Changed a.txt.', session_id: SESSION });
    await until(() => events.some((event) => event.kind === 'status' && event.status === 'turnEnded'), 'the turn');
    handle.finish();
    expect(await handle.done).toEqual({ kind: 'ended', summary: 'Changed a.txt.' });
    const lines = await readFile(path.join(dir, 'home', 'sessions', SESSION, 'events.jsonl'), 'utf8');
    expect(lines.trim().split('\n').at(-1)).toContain('"type":"session.finished","outcome":"completed"');
  });

  it('reports Claude\'s tokens from each result message before the turn\'s end, summed over modelUsage (phase 9, step 33)', async () => {
    const { handle } = start();
    await until(() => options !== undefined, 'query');
    fake.push({ type: 'system', subtype: 'init', session_id: SESSION, tools: [] });
    fake.push({
      type: 'result',
      subtype: 'success',
      result: 'Done.',
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
      modelUsage: {
        'claude-a': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 },
        'claude-b': { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 },
      },
    });
    await until(() => events.some((event) => event.kind === 'status' && event.status === 'turnEnded'), 'the turn');
    const usage = events.findIndex((event) => event.kind === 'usage');
    const ended = events.findIndex((event) => event.kind === 'status' && event.status === 'turnEnded');
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThan(ended);
    expect(events[usage]).toEqual({ kind: 'usage', usage: { input: 105, output: 22, cacheRead: 300, cacheCreation: 40 } });
    handle.finish();
    await handle.done;
  });

  it('claudeUsageOf: modelUsage first, the main loop\'s usage without it, nothing from a message without counts', () => {
    expect(claudeUsageOf({ usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } })).toEqual({ input: 10, output: 3, cacheRead: 7, cacheCreation: 2 });
    expect(claudeUsageOf({ usage: { input_tokens: 10, output_tokens: 3 } })).toEqual({ input: 10, output: 3, cacheRead: 0, cacheCreation: 0 });
    expect(claudeUsageOf({ modelUsage: {}, usage: { input_tokens: 4, output_tokens: 1 } })).toEqual({ input: 4, output: 1, cacheRead: 0, cacheCreation: 0 });
    expect(claudeUsageOf({ modelUsage: { m: { inputTokens: 'x', outputTokens: 1 } } })).toBeUndefined();
    // A malformed modelUsage falls back to usage.
    expect(claudeUsageOf({ modelUsage: { m: { inputTokens: 'x', outputTokens: 1 } }, usage: { input_tokens: 2, output_tokens: 1 } })).toEqual({ input: 2, output: 1, cacheRead: 0, cacheCreation: 0 });
    expect(claudeUsageOf({ usage: { input_tokens: -1, output_tokens: 1 } })).toBeUndefined();
    expect(claudeUsageOf({ type: 'result' })).toBeUndefined();
    expect(claudeUsageOf(null)).toBeUndefined();
    expect(claudeTokens({ input: 10, output: 3, cacheRead: 7, cacheCreation: 2 })).toEqual({ noCache: 13, withCache: 22 });
  });

  it('in a build\'s round (phase 9): a question is refused, never asked, and a denial says nobody was asked', async () => {
    const { handle } = start([], true);
    await until(() => options !== undefined, 'query');
    fake.push({ type: 'system', subtype: 'init', session_id: SESSION, tools: [] });
    await handle.sessionId;
    const refused = await options?.canUseTool?.('AskUserQuestion', { questions: [{ question: 'Which?', header: 'W', options: [{ label: 'A', description: '' }], multiSelect: false }] }, { signal: new AbortController().signal } as never);
    expect(refused).toEqual({ behavior: 'deny', message: UNATTENDED_QUESTION });
    expect(questions).toHaveLength(0);
    expect(events.find((event) => event.kind === 'denial')).toMatchObject({ toolName: 'AskUserQuestion', reason: UNATTENDED_QUESTION });
    // The decision is the manager's (here: deny); the session reads the build's text, not "the user did not allow".
    const denied = await pre('Bash', { command: 'curl https://example.com' }, 'toolu_3');
    expect(decisionOf(denied)).toBe('deny');
    expect((denied as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason).toBe(UNATTENDED_DENIED);
    const viaCanUse = await options?.canUseTool?.('Bash', { command: 'curl https://example.com' }, { signal: new AbortController().signal, toolUseID: 'toolu_4' } as never);
    expect(viaCanUse).toEqual({ behavior: 'deny', message: UNATTENDED_DENIED });
    // Not unattended: the permission mode, tools and settings are the task's, the same as any round.
    expect(options?.permissionMode).toBe('auto');
    fake.close();
    await handle.done;
  });

  it('denies everything once cancelled, and ends as stopped', async () => {
    const { handle } = start();
    await until(() => options !== undefined, 'query');
    fake.push({ type: 'system', subtype: 'init', session_id: SESSION, tools: [] });
    await handle.sessionId;
    handle.requestCancel();
    expect(decisionOf(await pre('Read', { file_path: path.join(worktree, 'a.txt') }))).toBe('deny');
    const rules = JSON.parse(await readFile(path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json'), 'utf8')) as Record<string, unknown>;
    expect(rules).toMatchObject({ cancelled: true, sessionIds: [SESSION] });
    await handle.stop();
    expect(await handle.done).toEqual({ kind: 'stopped' });
  });
});

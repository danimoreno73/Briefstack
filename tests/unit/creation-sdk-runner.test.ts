import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CanUseTool, HookCallback, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SdkRunner, buildQueryOptions, cleanEnvironment, describeToolUse, type QueryFn } from '../../src/creation/sdkRunner.js';
import type { TrackedSpawn } from '../../src/creation/processTree.js';
import type {
  PermissionRequest,
  QuestionRequest,
  QuestionResult,
  RunnerEvent,
  RunnerHandle,
  RunnerIO,
  SpecDecision,
} from '../../src/creation/types.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir } from '../helpers.js';

const SESSION = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';
// Built at run time so the test file holds no secret-looking string.
const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

describe('buildQueryOptions', () => {
  const base = () =>
    buildQueryOptions({
      repoDir: '/repo',
      executable: '/bin/claude',
      profile: { name: 'balanced', sessionModel: 'sonnet', effort: 'medium' },
      env: { A: '1' },
      additionalDirectories: ['/projects', '/sessions'],
      hooks: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
      mcpServers: {},
      abortController: new AbortController(),
      spawn: () => {
        throw new Error('not used');
      },
    });

  it('runs in auto mode from the repo, with the user claude and only the project and local settings', () => {
    const options = base();
    expect(options).toMatchObject({
      cwd: '/repo',
      pathToClaudeCodeExecutable: '/bin/claude',
      permissionMode: 'auto',
      settingSources: ['project', 'local'],
      strictMcpConfig: true,
      model: 'sonnet',
      effort: 'medium',
      additionalDirectories: ['/projects', '/sessions'],
    });
    expect(options.allowedTools).toEqual(['mcp__briefstack-web__approve_spec', 'mcp__briefstack-web__grant_directory']);
  });

  it('offers only the built-in tools the flow uses', () => {
    const { tools } = base();
    expect(Array.isArray(tools)).toBe(true);
    const list = tools as string[];
    for (const needed of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'PowerShell', 'Agent', 'AskUserQuestion', 'WebSearch', 'WebFetch']) {
      expect(list, needed).toContain(needed);
    }
    for (const never of ['Monitor', 'CronCreate', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'RemoteTrigger', 'PushNotification', 'ScheduleWakeup', 'NotebookEdit', 'TaskCreate']) {
      expect(list, never).not.toContain(never);
    }
  });

  it('never bypasses permissions', () => {
    const options = base();
    expect(options.permissionMode).not.toBe('bypassPermissions');
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(Object.keys(options)).not.toContain('dangerouslySkipPermissions');
  });

  it('leaves model and effort out when the profile has none or an unknown one', () => {
    const options = buildQueryOptions({
      repoDir: '/repo',
      executable: '/bin/claude',
      profile: { name: 'x', effort: 'turbo' },
      env: {},
      additionalDirectories: [],
      hooks: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
      mcpServers: {},
      abortController: new AbortController(),
      spawn: () => {
        throw new Error('not used');
      },
    });
    expect(options).not.toHaveProperty('model');
    expect(options).not.toHaveProperty('effort');
  });
});

describe('cleanEnvironment', () => {
  it('drops credentials and Claude Code variables, reports only names, and fixes the home', () => {
    const { env, removed } = cleanEnvironment(
      {
        ANTHROPIC_API_KEY: FAKE_KEY,
        ANTHROPIC_AUTH_TOKEN: 'token-value',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        PATH: '/bin',
        BRIEFSTACK_HOME: '/old',
      },
      '/new-home',
    );
    expect(removed.sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(JSON.stringify(removed)).not.toContain(FAKE_KEY);
    expect(env).toEqual({ PATH: '/bin', BRIEFSTACK_HOME: '/new-home' });
  });
});

describe('describeToolUse', () => {
  it('shows the command, path or url, with secrets hidden', () => {
    expect(describeToolUse('Bash', { command: 'ls -la' })).toBe('Bash: ls -la');
    expect(describeToolUse('WebFetch', { url: 'https://example.com/a' })).toBe('WebFetch: https://example.com/a');
    expect(describeToolUse('Write', { file_path: '/p/a.md', content: 'long' })).toBe('Write: /p/a.md');
    const secret = describeToolUse('Bash', { command: `curl -H "x-api-key: ${FAKE_KEY}" https://example.com` });
    expect(secret).not.toContain(FAKE_KEY);
    expect(describeToolUse('Other', { a: 1 })).toBe('Other: {"a":1}');
    expect(describeToolUse('Bash', { command: 'x'.repeat(2000) }).length).toBeLessThanOrEqual(500);
  });
});

/** A scripted stand-in for the SDK's `query()`. */
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

describe('SdkRunner', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let projectsDir: string;
  let sessionsDir: string;
  let fake: FakeQuery;
  let captured: { prompt: unknown; options: Options } | undefined;
  let firstPrompt: unknown;
  let killed: number;
  let events: RunnerEvent[];
  let asked: QuestionRequest[];
  let permissions: PermissionRequest[];
  let answer: QuestionResult;
  let permissionAnswer: 'allow' | 'deny';
  let specAnswer: SpecDecision;
  let grantAnswer: boolean;
  /** While set, questions and the spec wait for it: the user is thinking. */
  let gate: Promise<void> | undefined;

  const io = (): RunnerIO => ({
    askQuestions: async (request) => {
      asked.push(request);
      await gate;
      return answer;
    },
    requestPermission: async (request) => {
      permissions.push(request);
      await gate;
      return permissionAnswer;
    },
    approveSpec: async () => {
      await gate;
      return specAnswer;
    },
    grantDirectory: async () => grantAnswer,
    emit: (event) => events.push(event),
  });

  const tracked = (): TrackedSpawn => ({
    spawn: () => {
      throw new Error('the fake query never spawns');
    },
    killTree: async () => {
      killed += 1;
    },
  });

  const runner = (overrides: Partial<ConstructorParameters<typeof SdkRunner>[0]> = {}) =>
    new SdkRunner({
      repoDir: PACKAGE_ROOT,
      pathEnv: {
        env: { PATH: '/bin', BRIEFSTACK_HOME: path.join(dir, 'home'), ANTHROPIC_API_KEY: FAKE_KEY },
        homedir: path.join(dir, 'user'),
        pathApi: path,
        caseInsensitive: process.platform !== 'linux',
      },
      locations: async () => ({ projectsDir, libraryDir: path.join(dir, 'library') }),
      findExecutable: () => '/bin/claude',
      tracked,
      query: ((params) => {
        captured = params as { prompt: unknown; options: Options };
        // Read the first user message the way the SDK would.
        const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        void iterator.next().then((result) => {
          firstPrompt = result.value;
        });
        return fake as unknown as Query;
      }) satisfies QueryFn,
      ...overrides,
    });

  const start = (r = runner()): RunnerHandle =>
    r.start({ creationId: 'c1', idea: 'A garden planner', profile: { name: 'balanced', sessionModel: 'sonnet', effort: 'medium' }, sessionsDir, policy: 'ask', io: io() });

  const init = (extra: Record<string, unknown> = {}) =>
    fake.push({ type: 'system', subtype: 'init', session_id: SESSION, slash_commands: ['new-project', 'usage'], ...extra });
  const options = (): Options => captured?.options ?? {};
  const canUse = (tool: string, input: Record<string, unknown>, agentID?: string) =>
    (options().canUseTool as CanUseTool)(tool, input, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r', ...(agentID === undefined ? {} : { agentID }) });
  const preToolUse = (tool: string, input: Record<string, unknown>, who: Record<string, unknown> = {}) => {
    const hook = options().hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    return hook(
      { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '', cwd: '', tool_name: tool, tool_input: input, tool_use_id: 't', ...who } as never,
      't',
      { signal: new AbortController().signal },
    );
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('sdk-runner'));
    projectsDir = path.join(dir, 'projects');
    sessionsDir = path.join(dir, 'home', 'sessions');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(path.join(sessionsDir, SESSION), { recursive: true });
    fake = new FakeQuery();
    captured = undefined;
    firstPrompt = undefined;
    killed = 0;
    events = [];
    asked = [];
    permissions = [];
    answer = { decision: 'answer', answers: { 'Which folder?': 'Default' } };
    permissionAnswer = 'allow';
    specAnswer = { decision: 'approve' };
    grantAnswer = true;
    gate = undefined;
  });
  afterEach(() => cleanup());

  it('starts the skill with the idea, reports the session id, and runs in the home the server uses', async () => {
    const handle = start();
    init();
    expect(await handle.sessionId).toBe(SESSION);
    expect(firstPrompt).toMatchObject({ type: 'user', message: { role: 'user', content: '/new-project A garden planner' }, parent_tool_use_id: null });
    expect(options().env?.BRIEFSTACK_HOME).toBe(path.join(dir, 'home'));
    expect(options().env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(events[0]).toMatchObject({ kind: 'status', status: 'starting', message: 'Not passed to Claude Code: ANTHROPIC_API_KEY' });
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
    expect(options().additionalDirectories).toEqual([projectsDir, sessionsDir]);
    await tick();
    expect(events).toContainEqual({ kind: 'status', status: 'running' });
    await handle.stop();
  });

  it('records the effort of the first PreToolUse that reports one, once, next to the requested one', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    const hooks = options().hooks?.PreToolUse?.flatMap((matcher) => matcher.hooks) ?? [];
    const fire = async (extra: Record<string, unknown>) => {
      for (const hook of hooks) {
        await hook(
          { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '', cwd: '', tool_name: 'Read', tool_input: {}, tool_use_id: 't', ...extra } as never,
          't',
          { signal: new AbortController().signal },
        );
      }
    };
    await fire({});
    await fire({ session_id: 'someone-else', effort: { level: 'max' } });
    expect(events.filter((event) => event.kind === 'effort')).toEqual([]);
    await fire({ effort: { level: 'low' } });
    await fire({ effort: { level: 'high' } });
    expect(events.filter((event) => event.kind === 'effort')).toEqual([{ kind: 'effort', level: 'low', requested: 'medium' }]);
    await handle.stop();
  });

  it('turns AskUserQuestion into the form and back into updatedInput.answers', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    const questions = [{ question: 'Which folder?', header: 'Folder', options: [{ label: 'Default', description: 'd' }], multiSelect: false }];
    const result = await canUse('AskUserQuestion', { questions });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.questions[0]?.question).toBe('Which folder?');
    expect(result).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which folder?': 'Default' } } });
    expect(await canUse('AskUserQuestion', { questions: [] })).toMatchObject({ behavior: 'deny' });
    answer = { decision: 'cancel' };
    expect(await canUse('AskUserQuestion', { questions })).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/cancel/i) });
    await handle.stop();
  });

  it('asks the user for anything else, with the secret hidden and the subagent named', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    // SubagentStart is how the runner learns which agent a request comes from.
    const start2 = options().hooks?.SubagentStart?.[0]?.hooks[0] as HookCallback;
    await start2({ hook_event_name: 'SubagentStart', session_id: SESSION, transcript_path: '', cwd: '', agent_id: 'a1', agent_type: 'researcher' } as never, undefined, { signal: new AbortController().signal });
    expect(await canUse('WebFetch', { url: `https://example.com/?k=${FAKE_KEY}` }, 'a1')).toMatchObject({ behavior: 'allow' });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({ toolName: 'WebFetch', agentType: 'researcher' });
    expect(JSON.stringify(permissions)).not.toContain(FAKE_KEY);
    permissionAnswer = 'deny';
    expect(await canUse('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' });
    await handle.stop();
  });

  it('reports what the guard denies', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    const outcome = await preToolUse('Bash', { command: 'rm -rf /' }, { agent_id: 'a2', agent_type: 'generator' });
    expect(outcome).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'denial', toolName: 'Bash', agentType: 'generator' }));
    // An ordinary session of this repo (another id) is not touched.
    expect(await preToolUse('Bash', { command: 'rm -rf /' }, { session_id: 'someone-else' })).toEqual({});
    await handle.stop();
  });

  it('claims the first session id it sees from a hook, when the hook comes before the init message is read', async () => {
    const handle = start();
    await tick();
    expect(await preToolUse('Write', { file_path: path.join(projectsDir, 'a.md') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await handle.sessionId).toBe(SESSION);
    await handle.stop();
  });

  it('after a cancel denies everything but the close, in the guard and in canUseTool', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    handle.requestCancel();
    expect(await preToolUse('Write', { file_path: path.join(projectsDir, 'a.md') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await preToolUse('Bash', { command: `npm run --silent briefstack -- event session finished --session ${SESSION} --outcome cancelled` })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    expect(await canUse('WebFetch', { url: 'https://example.com' })).toMatchObject({ behavior: 'deny' });
    expect(permissions).toHaveLength(0);
    await handle.stop();
  });

  it('lets a folder the user granted be written for this session, and says so to Claude Code', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    const output = path.join(dir, 'chosen', 'out');
    const server = options().mcpServers?.['briefstack-web'] as unknown as { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }> } };
    expect(await preToolUse('Write', { file_path: path.join(output, 'a.md') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const reply = await server.instance._registeredTools.grant_directory?.handler({ dir: output }, {});
    expect(JSON.parse(reply?.content[0]?.text ?? '{}')).toEqual({ granted: true });
    expect(await preToolUse('Write', { file_path: path.join(output, 'a.md') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await canUse('Write', { file_path: path.join(output, 'a.md') })).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addDirectories', directories: [path.resolve(output)], destination: 'session' }],
    });
    await handle.stop();
  });

  it('fails clearly when Claude Code is missing or the skill is not listed', async () => {
    const missing = start(runner({ findExecutable: () => undefined }));
    expect(await missing.done).toMatchObject({ kind: 'failed', error: expect.stringContaining('Claude Code was not found') });
    await expect(missing.sessionId).rejects.toBeDefined();

    const handle = start();
    init({ slash_commands: ['usage'] });
    expect(await handle.done).toMatchObject({ kind: 'failed', error: expect.stringContaining('/new-project') });
    expect(fake.closed).toBe(true);
  });

  it('ends as stopped on stop(), closes the query and kills the process tree', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    await handle.stop();
    expect(await handle.done).toEqual({ kind: 'stopped' });
    expect(fake.closed).toBe(true);
    expect(killed).toBeGreaterThan(0);
  });

  it('ends by itself when nothing arrives for a while after a turn ended', async () => {
    const handle = start(runner({ idleAfterResultMs: 30 }));
    init();
    await handle.sessionId;
    fake.push({ type: 'result', subtype: 'success' });
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(events).toContainEqual({ kind: 'status', status: 'turnEnded' });
  });

  it('keeps waiting while messages keep coming after a result (a background agent is working)', async () => {
    const handle = start(runner({ idleAfterResultMs: 80 }));
    init();
    await handle.sessionId;
    fake.push({ type: 'result', subtype: 'success' });
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      fake.push({ type: 'system', subtype: 'task_progress' });
    }
    expect(fake.closed).toBe(false);
    expect(await handle.done).toEqual({ kind: 'ended' });
  });
  describe('the wait after a turn ended', () => {
    const settled = (promise: Promise<unknown>): Promise<boolean> =>
      Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))]);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('does not run while a question waits for the user, however long they take', async () => {
      const handle = start(runner({ idleAfterResultMs: 30 }));
      init();
      await handle.sessionId;
      fake.push({ type: 'result', subtype: 'success' });
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      const questions = [{ question: 'Which folder?', header: 'Folder', options: [{ label: 'Default', description: 'd' }], multiSelect: false }];
      const asking = canUse('AskUserQuestion', { questions });
      await pause(150);
      expect(fake.closed).toBe(false);
      expect(await settled(handle.done)).toBe(false);
      release();
      expect(await asking).toMatchObject({ behavior: 'allow' });
      // Answered: the quiet wait starts again, and ends it.
      expect(await handle.done).toEqual({ kind: 'ended' });
    });

    it('does not run while a permission request waits', async () => {
      const handle = start(runner({ idleAfterResultMs: 30 }));
      init();
      await handle.sessionId;
      fake.push({ type: 'result', subtype: 'success' });
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      const asking = canUse('WebFetch', { url: 'https://example.com' });
      await pause(150);
      expect(fake.closed).toBe(false);
      expect(await settled(handle.done)).toBe(false);
      expect(permissions).toHaveLength(1);
      release();
      expect(await asking).toMatchObject({ behavior: 'allow' });
      expect(await handle.done).toEqual({ kind: 'ended' });
    });

    it('does not run while the spec approval waits', async () => {
      const handle = start(runner({ idleAfterResultMs: 30 }));
      init();
      await handle.sessionId;
      fake.push({ type: 'result', subtype: 'success' });
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      const server = options().mcpServers?.['briefstack-web'] as unknown as {
        instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }> };
      };
      const files = { specFile: path.join(sessionsDir, SESSION, 'spec.json'), summaryFile: path.join(sessionsDir, SESSION, 'summary.md') };
      const approving = server.instance._registeredTools.approve_spec?.handler(files, {});
      await pause(150);
      expect(fake.closed).toBe(false);
      expect(await settled(handle.done)).toBe(false);
      release();
      expect(JSON.parse((await approving)?.content[0]?.text ?? '{}')).toEqual({ decision: 'approve' });
      expect(await handle.done).toEqual({ kind: 'ended' });
    });

    it('waits much longer while a background agent is running, and still ends if its stop never comes', async () => {
      const handle = start(runner({ idleAfterResultMs: 30, idleWithAgentsMs: 250 }));
      init();
      await handle.sessionId;
      const hook = options().hooks?.SubagentStart?.[0]?.hooks[0] as HookCallback;
      const signal = new AbortController().signal;
      await hook({ hook_event_name: 'SubagentStart', session_id: SESSION, transcript_path: '', cwd: '', agent_id: 'a1', agent_type: 'generator' } as never, undefined, { signal });
      fake.push({ type: 'result', subtype: 'success' });
      await pause(120);
      expect(fake.closed).toBe(false);
      // Its stop comes: the short wait applies from then on.
      const stop = options().hooks?.SubagentStop?.[0]?.hooks[0] as HookCallback;
      await stop({ hook_event_name: 'SubagentStop', session_id: SESSION, transcript_path: '', cwd: '', agent_id: 'a1', agent_type: 'generator' } as never, undefined, { signal });
      expect(await handle.done).toEqual({ kind: 'ended' });

      // A stop that never comes: the long wait still ends it.
      fake = new FakeQuery();
      const lost = start(runner({ idleAfterResultMs: 30, idleWithAgentsMs: 120 }));
      init();
      await lost.sessionId;
      await (options().hooks?.SubagentStart?.[0]?.hooks[0] as HookCallback)(
        { hook_event_name: 'SubagentStart', session_id: SESSION, transcript_path: '', cwd: '', agent_id: 'a2', agent_type: 'generator' } as never,
        undefined,
        { signal },
      );
      fake.push({ type: 'result', subtype: 'success' });
      expect(await lost.done).toEqual({ kind: 'ended' });
    });
  });

});

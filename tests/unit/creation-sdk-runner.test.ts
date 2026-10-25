import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanUseTool, HookCallback, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SdkRunner,
  WEB_REMINDERS,
  buildQueryOptions,
  cleanEnvironment,
  describeToolUse,
  webReminderHook,
  type QueryFn,
} from '../../src/creation/sdkRunner.js';
import type { TrackedSpawn } from '../../src/creation/processTree.js';
import { ALLOWED_DIRS_ENV } from '../../src/library/settings.js';
import type {
  ClaimResult,
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

  it('runs in auto mode from the repo, with the user claude and only the project settings', () => {
    const options = base();
    expect(options).toMatchObject({
      cwd: '/repo',
      pathToClaudeCodeExecutable: '/bin/claude',
      permissionMode: 'auto',
      settingSources: ['project'],
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

  it('always passes the profile model, and ANTHROPIC_MODEL from the server never reaches the session', () => {
    const { env } = cleanEnvironment({ ANTHROPIC_MODEL: 'claude-opus-4-1', PATH: '/bin' }, '/home');
    const options = buildQueryOptions({
      repoDir: '/repo',
      executable: '/bin/claude',
      profile: { name: 'saver', sessionModel: 'haiku', effort: 'low' },
      env,
      additionalDirectories: [],
      hooks: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
      mcpServers: {},
      abortController: new AbortController(),
      spawn: () => {
        throw new Error('not used');
      },
    });
    expect(options.model).toBe('haiku');
    expect(options.env).not.toHaveProperty('ANTHROPIC_MODEL');
  });

  it('leaves the effort out when the profile has an unknown one', () => {
    const options = buildQueryOptions({
      repoDir: '/repo',
      executable: '/bin/claude',
      profile: { name: 'x', sessionModel: 'sonnet', effort: 'turbo' },
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
    expect(options.model).toBe('sonnet');
    expect(options).not.toHaveProperty('effort');
  });
});

describe('cleanEnvironment', () => {
  it('never passes on a list of allowed folders from the server environment', () => {
    const { env, removed } = cleanEnvironment({ [ALLOWED_DIRS_ENV]: '["/elsewhere"]', PATH: '/bin' }, '/home');
    expect(env).not.toHaveProperty(ALLOWED_DIRS_ENV);
    expect(removed).toEqual([ALLOWED_DIRS_ENV]);
  });

  it('turns auto memory off even when the server environment turns it on', () => {
    const { env } = cleanEnvironment({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', PATH: '/bin' }, '/home');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('turns background tasks off even when the server environment sets them otherwise', () => {
    const { env, removed } = cleanEnvironment({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', PATH: '/bin' }, '/home');
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(removed).toEqual(['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']);
  });

  it("passes the user's own credentials as they are, drops Claude Code's other variables, reports only names, and fixes the home", () => {
    const { env, removed } = cleanEnvironment(
      {
        ANTHROPIC_API_KEY: FAKE_KEY,
        ANTHROPIC_AUTH_TOKEN: 'token-value',
        ANTHROPIC_MODEL: 'opus',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        PATH: '/bin',
        BRIEFSTACK_HOME: '/old',
      },
      '/new-home',
    );
    expect(removed.sort()).toEqual(['ANTHROPIC_MODEL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);
    expect(JSON.stringify(removed)).not.toContain(FAKE_KEY);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: FAKE_KEY,
      ANTHROPIC_AUTH_TOKEN: 'token-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value',
      PATH: '/bin',
      BRIEFSTACK_HOME: '/new-home',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
  });

  it('passes a cloud provider configuration and network settings, and nothing else of Claude Code', () => {
    const provider = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      CLAUDE_CODE_USE_MANTLE: '1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
      CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: '1',
      CLAUDE_CODE_SKIP_MANTLE_AUTH: '1',
      CLAUDE_CODE_SKIP_AWS_CRED_CACHE: '1',
      CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS: '30000',
      CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK: '1',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
      CLAUDE_CODE_CLIENT_CERT: '/certs/c.pem',
      CLAUDE_CODE_CLIENT_KEY: '/certs/k.pem',
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'pass',
      CLAUDE_CODE_CERT_STORE: 'system',
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'work',
      ANTHROPIC_VERTEX_PROJECT_ID: 'p',
      CLOUD_ML_REGION: 'global',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'some-opus-id',
      HTTPS_PROXY: 'http://proxy.example.com:8080',
    };
    const { env, removed } = cleanEnvironment(
      { ...provider, CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' },
      '/home',
    );
    expect(env).toMatchObject(provider);
    expect(removed.sort()).toEqual(['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_USE_POWERSHELL_TOOL']);
  });
});

describe('webReminderHook', () => {
  const hook = webReminderHook((id) => id === SESSION);
  const run = (command: string, extra: Record<string, unknown> = {}) =>
    hook(
      {
        hook_event_name: 'PostToolUse',
        session_id: SESSION,
        transcript_path: '',
        cwd: '',
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: {},
        tool_use_id: 't',
        ...extra,
      } as never,
      't',
      { signal: new AbortController().signal },
    );
  const context = (output: unknown) => (output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;

  it('reminds the main session of approve_spec after spec check and of grant_directory after paths check', async () => {
    expect(context(await run('npm run --silent briefstack -- spec check "C:/s/spec.json"'))).toBe(WEB_REMINDERS.specCheck);
    expect(context(await run('npm run --silent briefstack -- paths check "C:/p/app" --json'))).toBe(WEB_REMINDERS.pathsCheck);
    expect(WEB_REMINDERS.specCheck).toContain('mcp__briefstack-web__approve_spec');
    expect(WEB_REMINDERS.pathsCheck).toContain('mcp__briefstack-web__grant_directory');
  });

  it('says nothing after other commands, for subagents or for other sessions', async () => {
    expect(context(await run('npm run --silent briefstack -- paths --json'))).toBeUndefined();
    expect(context(await run('npm run --silent briefstack -- validate "C:/p/app"'))).toBeUndefined();
    expect(context(await run('npm run --silent briefstack -- spec check "C:/s/spec.json"', { agent_id: 'a1', agent_type: 'architect' }))).toBeUndefined();
    expect(context(await run('npm run --silent briefstack -- spec check "C:/s/spec.json"', { session_id: 'other' }))).toBeUndefined();
    expect(context(await run('spec check; echo'))).toBeUndefined();
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
  let claimed: string[] = [];
  let claimAnswer: ClaimResult = { ok: true };
  let heldBy: (target: string) => string | undefined = () => undefined;
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
    claimFolder: (dir) => (claimed.push(dir), claimAnswer),
    folderHeldByOther: (target) => heldBy(target),
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
        env: { PATH: '/bin', BRIEFSTACK_HOME: path.join(dir, 'home'), ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_MODEL: 'opus' },
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
    fake.push({
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      slash_commands: ['new-project', 'usage'],
      tools: ['Read', 'Agent', 'mcp__briefstack-web__approve_spec', 'mcp__briefstack-web__grant_directory'],
      mcp_servers: [{ name: 'briefstack-web', status: 'connected' }],
      ...extra,
    });
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
    claimed = [];
    claimAnswer = { ok: true };
    heldBy = () => undefined;
    gate = undefined;
  });
  afterEach(() => cleanup());

  it('starts the skill with the idea, reports the session id, and runs in the home the server uses', async () => {
    const handle = start();
    init();
    expect(await handle.sessionId).toBe(SESSION);
    expect(firstPrompt).toMatchObject({ type: 'user', message: { role: 'user', content: '/new-project A garden planner' }, parent_tool_use_id: null });
    expect(options().env?.BRIEFSTACK_HOME).toBe(path.join(dir, 'home'));
    // The user's own key reaches their Claude Code; it is never in what the runner reports.
    expect(options().env?.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(events[0]).toMatchObject({ kind: 'status', status: 'starting', message: 'Not passed to Claude Code: ANTHROPIC_MODEL' });
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
    expect(options().additionalDirectories).toEqual([projectsDir, sessionsDir]);
    // `briefstack paths` inside the session reports the same two folders, not the repo's settings file.
    expect(JSON.parse(options().env?.[ALLOWED_DIRS_ENV] ?? 'null')).toEqual([projectsDir, sessionsDir]);
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

  it('registers the folder claim hook next to the guard: it claims at paths check and its deny wins', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    const hooks = options().hooks?.PreToolUse?.flatMap((matcher) => matcher.hooks) ?? [];
    expect(hooks).toHaveLength(3);
    const claimHook = hooks[1] as HookCallback;
    const fire = (tool: string, input: Record<string, unknown>) =>
      claimHook(
        { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '', cwd: '', tool_name: tool, tool_input: input, tool_use_id: 'u1' } as never,
        'u1',
        { signal: new AbortController().signal },
      );
    const garden = path.join(projectsDir, 'garden');
    const slash = (value: string) => value.replaceAll('\\', '/');
    expect(await fire('Bash', { command: `npm run --silent briefstack -- paths check "${slash(garden)}" --json` })).toEqual({});
    expect(claimed).toEqual([slash(garden)]);

    claimAnswer = { ok: false, holder: 'A recipe box' };
    const refused = (await fire('Bash', { command: `npm run --silent briefstack -- paths check "${slash(garden)}" --json` })) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain('Ask the user for another folder');
    expect(events.filter((event) => event.kind === 'denial')).toEqual([
      expect.objectContaining({ kind: 'denial', toolName: 'Bash', toolUseId: 'u1', reason: expect.stringContaining('A recipe box') }),
    ]);

    heldBy = (target) => (target.startsWith(garden) ? 'A recipe box' : undefined);
    const write = (await fire('Write', { file_path: path.join(garden, 'README.md'), content: 'x' })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(write.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(await fire('Write', { file_path: path.join(projectsDir, 'other', 'README.md'), content: 'x' })).toEqual({});
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

  it('reminds its own main session of approve_spec after spec check', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    const hook = options().hooks?.PostToolUse?.[0]?.hooks[0] as HookCallback;
    const output = await hook(
      {
        hook_event_name: 'PostToolUse',
        session_id: SESSION,
        transcript_path: '',
        cwd: '',
        tool_name: 'Bash',
        tool_input: { command: 'npm run --silent briefstack -- spec check "C:/s/spec.json"' },
        tool_response: {},
        tool_use_id: 't',
      } as never,
      't',
      { signal: new AbortController().signal },
    );
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: WEB_REMINDERS.specCheck } });
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

  it('registers the command-hook guard and keeps its rules current: session, grants and a cancel, removed at the end', async () => {
    const rulesFile = path.join(dir, 'home', 'runs', 'c1', 'guard.json');
    const rules = async () => JSON.parse(await readFile(rulesFile, 'utf8')) as Record<string, unknown>;
    const handle = start();
    for (let i = 0; i < 100 && captured === undefined; i += 1) await tick();
    // In place before claude starts, so its first tool call already has them.
    expect(await rules()).toEqual({
      v: 1,
      projectsDir,
      sessionsDir,
      libraryDir: path.join(dir, 'library'),
      cwd: PACKAGE_ROOT,
      granted: [],
      cancelled: false,
    });
    const hook = (options().settings as unknown as { hooks: { PreToolUse: { hooks: { args: string[]; onFailure: string }[] }[] } }).hooks.PreToolUse[0]?.hooks[0];
    expect(hook?.onFailure).toBe('block');
    expect(hook?.args.at(-1)).toBe(rulesFile);

    init();
    await handle.sessionId;
    expect((await rules()).sessionId).toBe(SESSION);
    const output = path.join(dir, 'chosen', 'out');
    const server = options().mcpServers?.['briefstack-web'] as unknown as { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> } };
    await server.instance._registeredTools.grant_directory?.handler({ dir: output }, {});
    expect((await rules()).granted).toEqual([path.resolve(output)]);
    handle.requestCancel();
    expect((await rules()).cancelled).toBe(true);
    await handle.stop();
    await expect(readFile(rulesFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('after the spec is approved, the guards let the generator install only its library skills', async () => {
    const rulesFile = path.join(dir, 'home', 'runs', 'c1', 'guard.json');
    const handle = start();
    init();
    await handle.sessionId;
    const sessionDir = path.join(sessionsDir, SESSION);
    await mkdir(sessionDir, { recursive: true });
    const files = { specFile: path.join(sessionDir, 'spec.json'), summaryFile: path.join(sessionDir, 'summary.md') };
    // As the server leaves it after the user unticked sync-helper.
    await writeFile(files.specFile, JSON.stringify({ librarySkills: [{ name: 'tidy-notes', reason: 'x' }] }), 'utf8');
    await writeFile(files.summaryFile, '# Summary\n', 'utf8');
    const app = path.join(projectsDir, 'app');
    await mkdir(path.join(app, '.briefstack'), { recursive: true });
    await writeFile(path.join(app, '.briefstack', 'spec.json'), JSON.stringify({ librarySkills: [{ name: 'tidy-notes', reason: 'x' }] }), 'utf8');
    const generator = { agent_id: 'g1', agent_type: 'generator' };
    const install = (extra: string) => preToolUse('Bash', { command: `npm run --silent briefstack -- skills install "${app.replaceAll('\\', '/')}"${extra}` }, generator);
    expect(await install('')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect((JSON.parse(await readFile(rulesFile, 'utf8')) as Record<string, unknown>).librarySkills).toBeUndefined();

    const server = options().mcpServers?.['briefstack-web'] as unknown as { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> } };
    await server.instance._registeredTools.approve_spec?.handler(files, {});
    expect((JSON.parse(await readFile(rulesFile, 'utf8')) as Record<string, unknown>).librarySkills).toEqual(['tidy-notes']);
    expect(await install('')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await install(' --skill sync-helper')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
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

  it('fails at once, before the flow runs, when the init message lacks the browser tools', async () => {
    const handle = start();
    init({ tools: ['Read', 'Agent', 'mcp__briefstack-web__grant_directory'], mcp_servers: [{ name: 'briefstack-web', status: 'failed' }] });
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ kind: 'failed' });
    const error = (outcome as { error: string }).error;
    expect(error).toContain('mcp__briefstack-web__approve_spec');
    expect(error).not.toContain('grant_directory');
    expect(error).toContain('briefstack-web: failed');
    expect(fake.closed).toBe(true);
    expect(events).not.toContainEqual({ kind: 'status', status: 'running' });
  });

  it('checks the tools on the first init only: later turns may list them otherwise', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    init({ tools: [] });
    await tick();
    expect(fake.closed).toBe(false);
    await handle.stop();
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

  it('keeps a run file while claude runs, naming its process, this server and the session, and removes it at the end', async () => {
    const runsDir = path.join(dir, 'home', 'runs');
    const file = path.join(runsDir, 'c1', 'run.json');
    const handle = start(
      runner({
        startTime: async (pid) => `start-${pid}`,
        tracked: () => ({ spawn: () => ({ pid: 4321 }) as never, killTree: async () => void (killed += 1) }),
      }),
    );
    for (let i = 0; i < 100 && captured === undefined; i += 1) await tick();
    // The SDK starts claude through this option.
    options().spawnClaudeCodeProcess?.({ command: 'claude', args: [], cwd: dir, env: {}, signal: new AbortController().signal });
    const read = async () => JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, unknown>;
    for (let i = 0; i < 100 && (await read()).claude === undefined; i += 1) await tick();
    expect(await read()).toMatchObject({
      v: 1,
      creationId: 'c1',
      claude: { pid: 4321, start: 'start-4321' },
      server: { pid: process.pid },
    });
    init();
    await handle.sessionId;
    for (let i = 0; i < 100 && (await read()).sessionId === undefined; i += 1) await tick();
    expect((await read()).sessionId).toBe(SESSION);
    fake.close();
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('ends by itself when nothing arrives for a while after a turn ended', async () => {
    const handle = start(runner({ idleAfterResultMs: 30 }));
    init();
    await handle.sessionId;
    fake.push({ type: 'result', subtype: 'success' });
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(events).toContainEqual({ kind: 'status', status: 'turnEnded' });
  });

  it('sends a free-text reply into the same input queue, and the idle stop no longer applies to that turn', async () => {
    const handle = start(runner({ idleAfterResultMs: 60 }));
    init();
    await handle.sessionId;
    fake.push({ type: 'result', subtype: 'success', result: 'Which name do you want?' });
    await tick();
    const iterator = (captured?.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    handle.sendMessage('Call it Seedling');
    expect((await iterator.next()).value).toEqual({ type: 'user', message: { role: 'user', content: 'Call it Seedling' }, parent_tool_use_id: null });
    // The idle stop is off until the next turn ends.
    await new Promise((resolve) => setTimeout(resolve, 120));
    let settled = false;
    void handle.done.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    await handle.stop();
  });

  it('sends the main session last text with the end of a turn, trimmed and cut', async () => {
    const handle = start();
    init();
    await handle.sessionId;
    fake.push({ type: 'result', subtype: 'success', result: '  Do you approve it?  ' });
    fake.push({ type: 'result', subtype: 'success', result: 'x'.repeat(5000) });
    await tick();
    const ended = events.filter((event) => event.kind === 'status' && event.status === 'turnEnded');
    expect(ended[0]).toEqual({ kind: 'status', status: 'turnEnded', message: 'Do you approve it?' });
    expect((ended[1] as { message: string }).message).toHaveLength(4000);
    await handle.stop();
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

import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_SYSTEM_PROMPT, SdkChatRunner, buildChatOptions } from '../../src/chat/sdkChatRunner.js';
import { CHAT_SERVER_NAME, CHAT_TOOL_IDS } from '../../src/chat/toolNames.js';
import type { ChatRunnerEvent, ToolReply } from '../../src/chat/types.js';
import type { TrackedSpawn } from '../../src/creation/processTree.js';
import type { QueryFn } from '../../src/creation/sdkRunner.js';

const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

/** A stand-in for the SDK's query: messages pushed by the test, or a failure. */
class FakeQuery {
  private readonly items: SDKMessage[] = [];
  private waiting: ((result: IteratorResult<SDKMessage, void>) => void) | undefined;
  private failure: ((error: Error) => void) | undefined;
  closed = false;

  push(message: Record<string, unknown>): void {
    const item = message as unknown as SDKMessage;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else this.items.push(item);
  }

  fail(error: Error): void {
    this.failure?.(error);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiting = resolve;
          this.failure = reject;
        });
      },
    };
  }
}

const tracked = (): TrackedSpawn => ({
  spawn: () => {
    throw new Error('never spawned');
  },
  killTree: async () => undefined,
});

function setup(resume?: string) {
  const fake = new FakeQuery();
  let captured: { prompt: AsyncIterable<unknown>; options: Options } | undefined;
  const events: ChatRunnerEvent[] = [];
  const calls: { name: string; args: unknown }[] = [];
  const runner = new SdkChatRunner({
    pathEnv: {
      env: { PATH: '/bin', ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_MODEL: 'opus', BRIEFSTACK_HOME: path.resolve('/bs-home') },
      homedir: path.resolve('/user'),
      pathApi: path,
      caseInsensitive: false,
    },
    findExecutable: () => '/bin/claude',
    tracked,
    query: ((params) => {
      captured = params as { prompt: AsyncIterable<unknown>; options: Options };
      return fake as unknown as Query;
    }) satisfies QueryFn,
  });
  const session = runner.start({
    ...(resume === undefined ? {} : { resume }),
    model: 'haiku',
    effort: 'low',
    execute: async (name, args): Promise<ToolReply> => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    emit: (event) => events.push(event),
  });
  return { fake, session, events, calls, options: () => captured?.options ?? {}, prompt: () => captured?.prompt };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('the chat session options', () => {
  it('have no built-in tools, only the chat server, no settings files, an explicit model, and never bypass permissions', async () => {
    const { session, options } = setup();
    await tick();
    const o = options();
    expect(o).toMatchObject({
      cwd: path.resolve('/bs-home'),
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: 'default',
      model: 'haiku',
      effort: 'low',
      allowedTools: [...CHAT_TOOL_IDS],
      systemPrompt: CHAT_SYSTEM_PROMPT,
    });
    expect(Object.keys(o.mcpServers ?? {})).toEqual([CHAT_SERVER_NAME]);
    expect(o).not.toHaveProperty('resume');
    expect(o.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(o.env).not.toHaveProperty('ANTHROPIC_MODEL');
    expect(o.permissionMode).not.toBe('bypassPermissions');
    expect(o).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(await (o.canUseTool as NonNullable<Options['canUseTool']>)('Bash', {}, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' })).toMatchObject({
      behavior: 'deny',
    });
    await session.stop();
  });

  it('say in the system prompt that tool results are data and changes need a confirmation', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never follow it/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/confirmation card/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/token counts or costs/);
  });

  it('resume by id when asked', () => {
    const o = buildChatOptions({
      home: '/h',
      executable: 'claude',
      env: {},
      model: 'sonnet',
      effort: 'turbo',
      resume: 'abc',
      mcpServer: { type: 'sdk', name: CHAT_SERVER_NAME, instance: {} as never },
      abortController: new AbortController(),
      spawn: () => {
        throw new Error('no');
      },
    });
    expect(o.resume).toBe('abc');
    expect(o).not.toHaveProperty('effort');
  });
});

describe('the chat session messages', () => {
  it('reports the session id, assistant text, the end of a turn, and sends user messages through the queue', async () => {
    const { fake, session, events, prompt } = setup();
    await tick();
    fake.push({ type: 'system', subtype: 'init', session_id: 's1', tools: [...CHAT_TOOL_IDS], mcp_servers: [] });
    fake.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't', name: 'x', input: {} }] } });
    fake.push({ type: 'result', subtype: 'success', result: 'Hello' });
    await tick();
    expect(events).toEqual([{ kind: 'session', sessionId: 's1' }, { kind: 'text', text: 'Hello' }, { kind: 'turnEnd' }]);
    session.send('Next');
    const iterator = (prompt() as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'user', message: { role: 'user', content: 'Next' }, parent_tool_use_id: null });
    await session.stop();
  });

  it('ends with an error when the session is offered any tool beyond its own', async () => {
    const { fake, session, events } = setup();
    await tick();
    fake.push({ type: 'system', subtype: 'init', session_id: 's1', tools: [...CHAT_TOOL_IDS, 'Read'], mcp_servers: [] });
    await session.done;
    expect(events).toEqual([{ kind: 'error', message: expect.stringContaining('Read') }]);
  });

  it('reports a failed resume when the session fails before it opens, and an error otherwise', async () => {
    const resumed = setup('gone');
    await tick();
    resumed.fake.fail(new Error('No conversation found with session ID: gone'));
    await resumed.session.done;
    expect(resumed.events).toEqual([{ kind: 'resumeFailed' }]);

    const fresh = setup();
    await tick();
    fresh.fake.fail(new Error('boom'));
    await fresh.session.done;
    expect(fresh.events).toEqual([{ kind: 'error', message: 'boom' }]);
  });

  it('reports an error result as an error', async () => {
    const { fake, session, events } = setup();
    await tick();
    fake.push({ type: 'system', subtype: 'init', session_id: 's1', tools: [], mcp_servers: [] });
    fake.push({ type: 'result', subtype: 'error_max_turns' });
    await tick();
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'The chat turn ended with error_max_turns.' });
    await session.stop();
  });
});

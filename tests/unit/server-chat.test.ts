import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeChatRunner, type ChatScript } from '../../src/chat/fakeChatRunner.js';
import { ChatManager } from '../../src/chat/manager.js';
import { ChatStore } from '../../src/chat/store.js';
import type { ChatStreamEvent, ChatView } from '../../src/chat/types.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { FAKE_KEY, chatWorld, type ChatWorld } from '../chatWorld.js';
import { useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

interface Reply {
  status: number;
  body: string;
}

function send(server: WebServer, urlPath: string, options: { method?: string; headers?: Record<string, string>; body?: string; until?: (body: string) => boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path: urlPath, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          // A stream never ends by itself: stop reading once the test has what it waits for.
          if (options.until?.(body) === true) {
            resolve({ status: res.statusCode ?? 0, body });
            req.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (error) => (options.until === undefined ? reject(error) : undefined));
    req.end(options.body);
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('chat API', () => {
  let world: ChatWorld;
  let server: WebServer | undefined;
  let chat: ChatManager | undefined;
  beforeEach(async () => {
    world = await chatWorld();
    await writeTree(path.join(world.dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
  });
  afterEach(async () => {
    await chat?.shutdown();
    await server?.close();
    chat = undefined;
    server = undefined;
    await world.cleanup();
  });

  const start = async (script?: ChatScript): Promise<WebServer> => {
    if (script !== undefined) {
      chat = await ChatManager.open({
        store: new ChatStore(path.join(world.home, 'chat')),
        runner: new FakeChatRunner(script),
        tools: world.tools,
        profile: async () => ({ model: 'haiku', effort: 'low' }),
      });
    }
    server = await startWebServer({
      port: 0,
      uiDir: path.join(world.dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      pathEnv: world.pathEnv,
      repoDir: world.repoDir,
      creations: world.creations,
      ...(chat === undefined ? {} : { chat }),
    });
    return server;
  };
  const auth = (s: WebServer) => ({ [TOKEN_HEADER]: s.token });
  const mutating = (s: WebServer) => ({ ...auth(s), origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  const post = (s: WebServer, urlPath: string, body?: unknown) =>
    send(s, urlPath, { method: 'POST', headers: mutating(s), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const view = async (s: WebServer): Promise<ChatView> => JSON.parse((await send(s, '/api/chat', { headers: auth(s) })).body) as ChatView;

  it('answers 503 chat.unavailable without a chat', async () => {
    const s = await start();
    expect((await send(s, '/api/chat', { headers: auth(s) })).status).toBe(503);
    expect(JSON.parse((await post(s, '/api/chat/messages', { text: 'x' })).body)).toMatchObject({ code: 'chat.unavailable' });
  });

  it('keeps every security check: token on reads, token and origin on writes', async () => {
    const s = await start({ turns: [] });
    expect((await send(s, '/api/chat')).status).toBe(401);
    expect((await send(s, '/api/chat/stream')).status).toBe(401);
    expect((await send(s, '/api/chat/threads')).status).toBe(401);
    const noOrigin = await send(s, '/api/chat/messages', { method: 'POST', headers: { ...auth(s), 'content-type': 'application/json' }, body: '{"text":"x"}' });
    expect(noOrigin.status).toBe(403);
    const crossSite = await send(s, '/api/chat/confirmations/abc', {
      method: 'POST',
      headers: { ...auth(s), origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: '{"decision":"confirm"}',
    });
    expect(crossSite.status).toBe(403);
  });

  it('takes a message, streams the answer, and the action runs only through the confirmation route', async () => {
    const s = await start({
      turns: [[{ call: 'list_projects' }, { sayResult: 'data.0.name' }], [{ call: 'start_creation', args: { idea: 'A recipe box' } }, { say: 'Done.' }]],
    });
    const before = await view(s);
    expect(before).toMatchObject({ messages: [], status: 'idle', model: { model: 'haiku', effort: 'low' } });
    const accepted = await post(s, '/api/chat/messages', { text: `Which projects? ${FAKE_KEY}` });
    expect(accepted.status).toBe(202);
    const answered = await waitFor(async () => {
      const current = await view(s);
      return current.status === 'idle' && current.messages.length === 3 ? current : undefined;
    });
    expect(answered.messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant']);
    expect(answered.messages[2]?.text).toBe('Garden planner');
    expect(JSON.stringify(answered)).not.toContain(FAKE_KEY);

    const streamed = await send(s, '/api/chat/stream?from=0', { headers: auth(s), until: (body) => body.includes('"text":"Garden planner"') && body.endsWith('\n\n') });
    expect(streamed.status).toBe(200);
    const frames = streamed.body
      .split('\n\n')
      .filter((block) => block.includes('data: '))
      .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 6)) as ChatStreamEvent);
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.some((frame) => frame.kind === 'message' && frame.data.text === 'Garden planner')).toBe(true);

    await post(s, '/api/chat/messages', { text: 'Start a recipe box' });
    const pending = await waitFor(async () => (await view(s)).pending);
    expect(world.creations.list()).toHaveLength(0);
    expect((await post(s, '/api/chat/messages', { text: 'hurry' })).status).toBe(409);
    expect((await post(s, `/api/chat/confirmations/${pending.id}`, { decision: 'maybe' })).status).toBe(400);
    expect(JSON.parse((await post(s, '/api/chat/confirmations/other', { decision: 'confirm' })).body)).toMatchObject({ code: 'chat.noConfirmation' });
    expect((await post(s, `/api/chat/confirmations/${pending.id}`, { decision: 'confirm' })).status).toBe(200);
    await waitFor(async () => ((await view(s)).status === 'idle' ? true : undefined));
    expect(world.creations.list().map((creation) => creation.idea)).toEqual(['A recipe box']);
  });

  it('checks message bodies', async () => {
    const s = await start({ turns: [] });
    for (const body of [{}, { text: '  ' }, { text: 'x'.repeat(10_001) }, { text: 'x', extra: true }]) {
      expect((await post(s, '/api/chat/messages', body)).status).toBe(400);
    }
  });

  it('starts a new chat and lists the old one read-only', async () => {
    const s = await start({ turns: [[{ say: 'Hi.' }]] });
    await post(s, '/api/chat/messages', { text: 'Hello' });
    const first = await waitFor(async () => {
      const current = await view(s);
      return current.status === 'idle' && current.messages.length === 2 ? current : undefined;
    });
    const fresh = JSON.parse((await post(s, '/api/chat/new')).body) as ChatView;
    expect(fresh.thread.id).not.toBe(first.thread.id);
    expect(fresh.messages).toEqual([]);
    const threads = JSON.parse((await send(s, '/api/chat/threads', { headers: auth(s) })).body) as { threads: { id: string; title: string; archivedAt?: string }[] };
    expect(threads.threads.map((thread) => thread.id)).toEqual([fresh.thread.id, first.thread.id]);
    expect(threads.threads[1]).toMatchObject({ title: 'Hello', archivedAt: expect.any(String) });
    const old = JSON.parse((await send(s, `/api/chat/threads/${first.thread.id}`, { headers: auth(s) })).body) as ChatView;
    expect(old.messages.map((message) => message.text)).toEqual(['Hello', 'Hi.']);
    expect((await send(s, '/api/chat/threads/not-a-thread', { headers: auth(s) })).status).toBe(404);
  });
});

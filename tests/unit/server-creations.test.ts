import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager, type CreationState, type StreamEvent } from '../../src/creation/manager.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { createRouter } from '../../src/server/router.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { tempDir, writeTree } from '../helpers.js';

const RECORDINGS = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings');

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw request, so tests can send any Host, Origin and token. */
function send(
  server: WebServer,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: urlPath,
        method: options.method ?? 'GET',
        headers: { host: `127.0.0.1:${server.port}`, ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

function parseSse(text: string): SseFrame[] {
  return text
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const frame: SseFrame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else {
          const [field, ...rest] = line.split(': ');
          (frame as Record<string, string>)[field as string] = rest.join(': ');
        }
      }
      return frame;
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

const UI = { 'index.html': '<html><head><!-- importmap --></head></html>' };

describe('creation API', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer | undefined;
  let manager: CreationManager | undefined;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-creations'));
    await writeTree(path.join(dir, 'ui'), UI);
  });
  afterEach(async () => {
    await manager?.shutdown();
    await server?.close();
    server = undefined;
    manager = undefined;
    await cleanup();
  });

  const start = async (
    options: { recording?: string; runner?: FakeRunner; lang?: 'en' | 'es'; withManager?: boolean; heartbeatMs?: number } = {},
  ): Promise<WebServer> => {
    if (options.withManager !== false) {
      const runner = options.runner ?? (await FakeRunner.fromFile(path.join(RECORDINGS, options.recording ?? 'full.jsonl')));
      manager = new CreationManager({
        runner,
        sessionsDir: path.join(dir, 'sessions'),
        policy: () => 'ask',
        profile: () => ({ name: 'balanced', sessionModel: 'sonnet' }),
        pollMs: 10,
      });
    }
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: options.lang ?? 'en',
      heartbeatMs: options.heartbeatMs ?? 15_000,
      ...(manager === undefined ? {} : { creations: manager }),
    });
    return server;
  };

  const auth = (s: WebServer) => ({ [TOKEN_HEADER]: s.token });
  const mutating = (s: WebServer) => ({
    ...auth(s),
    origin: s.origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  });
  const post = (s: WebServer, urlPath: string, body?: unknown) =>
    send(s, urlPath, { method: 'POST', headers: mutating(s), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const state = async (s: WebServer, id: string): Promise<CreationState> =>
    JSON.parse((await send(s, `/api/creations/${id}`, { headers: auth(s) })).body) as CreationState;

  const create = async (s: WebServer): Promise<string> => {
    const reply = await post(s, '/api/creations', { idea: 'A garden planner' });
    expect(reply.status).toBe(201);
    return (JSON.parse(reply.body) as { id: string }).id;
  };

  /** Answers every pending request with its default, over HTTP, until the creation finishes. */
  const driveToEnd = async (s: WebServer, id: string): Promise<CreationState> => {
    for (;;) {
      const current = await waitFor(async () => {
        const st = await state(s, id);
        return st.status === 'finished' || st.pending !== undefined ? st : undefined;
      });
      if (current.status === 'finished' || current.pending === undefined) return current;
      const pending = current.pending;
      const answer =
        pending.kind === 'question'
          ? Object.fromEntries(pending.payload.questions.map((q) => [q.question, q.options[0]?.label ?? '']))
          : pending.kind === 'permission'
            ? 'allow'
            : pending.kind === 'spec'
              ? { decision: 'approve' }
              : true;
      const reply = await post(s, `/api/creations/${id}/answer`, { pendingId: pending.id, answer });
      expect(reply.status).toBe(200);
    }
  };

  it('answers 503 creation.unavailable without a manager', async () => {
    const s = await start({ withManager: false });
    const reply = await post(s, '/api/creations', { idea: 'x' });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ code: 'creation.unavailable', params: {}, message: expect.any(String) });
    expect((await send(s, '/api/creations', { headers: auth(s) })).status).toBe(503);
    expect((await send(s, '/api/health', { headers: auth(s) })).status).toBe(200);
  });

  it('runs a whole creation over HTTP while a stream follows it to the end', async () => {
    const s = await start();
    const id = await create(s);
    const streamed = send(s, `/api/creations/${id}/stream`, { headers: auth(s) });

    const busy = await post(s, '/api/creations', { idea: 'Another' });
    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body)).toEqual({
      code: 'creation.busy',
      params: { active: id },
      message: `A creation is already running (${id}). Finish or cancel it before starting another one.`,
    });

    const final = await driveToEnd(s, id);
    expect(final).toMatchObject({ id, status: 'finished', outcome: 'completed', denied: [] });

    const reply = await streamed;
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const frames = parseSse(reply.body).filter((f) => f.id !== undefined);
    expect(frames.map((f) => Number(f.id))).toEqual(frames.map((_, i) => i + 1));
    const events = frames.map((f) => JSON.parse(f.data ?? '') as StreamEvent);
    expect(frames.map((f) => f.event)).toEqual(events.map((e) => e.kind));
    expect(events.at(-1)).toMatchObject({ kind: 'status', data: { status: 'finished', outcome: 'completed' } });
    expect(events.some((e) => e.kind === 'flow')).toBe(true);
    expect(events.some((e) => e.kind === 'spec')).toBe(true);

    const list = JSON.parse((await send(s, '/api/creations', { headers: auth(s) })).body) as { creations: CreationState[] };
    expect(list.creations.map((c) => c.id)).toEqual([id]);
  });

  describe('spec and secrets', () => {
    // Built at run time so the test file holds no secret-looking string.
    const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');
    const recording = [
      '{"do":"session","phase":"started"}',
      '{"do":"flow","step":"spec","phase":"started"}',
      JSON.stringify({ do: 'permission', toolName: 'Bash', summary: `curl -H "x-api-key: ${FAKE_KEY}" https://example.com` }),
      '{"do":"label","name":"write-spec"}',
      JSON.stringify({
        do: 'spec',
        onChange: 'write-spec',
        spec: JSON.stringify({
          name: 'Garden planner',
          slug: 'garden-planner',
          target: 'claude-code',
          targetChosenBy: 'architect',
          targetReason: `Files to check. ${FAKE_KEY}`,
          profile: 'balanced',
          ignored: 'x',
        }),
        summary: ['# Garden planner', '', `Key: ${FAKE_KEY}`, 'A planting calendar.', ''].join(String.fromCharCode(10)),
      }),
      '{"do":"flow","step":"spec","phase":"finished","outcome":"ok"}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ].join(String.fromCharCode(10));

    it('serves the spec summary of the pending approval, with secrets hidden', async () => {
      const s = await start({ runner: new FakeRunner({ steps: parseRecording(recording) }) });
      const id = await create(s);
      expect((await send(s, `/api/creations/${id}/spec`, { headers: auth(s) })).status).toBe(404);

      const permission = await waitFor(async () => {
        const st = await state(s, id);
        return st.pending?.kind === 'permission' ? st.pending : undefined;
      });
      // The permission dialog never shows the secret.
      expect(JSON.stringify(permission.payload)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(permission.payload)).toContain('[redacted]');
      await post(s, `/api/creations/${id}/answer`, { pendingId: permission.id, answer: 'deny' });

      const spec = await waitFor(async () => {
        const st = await state(s, id);
        return st.pending?.kind === 'spec' ? st.pending : undefined;
      });
      const reply = await send(s, `/api/creations/${id}/spec`, { headers: auth(s) });
      expect(reply.status).toBe(200);
      const view = JSON.parse(reply.body) as { summary: string; spec: Record<string, string> };
      expect(view.summary).toContain('# Garden planner');
      expect(view.summary).toContain('A planting calendar.');
      expect(reply.body).not.toContain(FAKE_KEY);
      // Only the fields the page shows.
      expect(view.spec).toEqual({
        name: 'Garden planner',
        slug: 'garden-planner',
        target: 'claude-code',
        targetChosenBy: 'architect',
        targetReason: '[redacted]',
        profile: 'balanced',
      });

      await post(s, `/api/creations/${id}/answer`, { pendingId: spec.id, answer: { decision: 'approve' } });
      expect((await send(s, '/api/creations/unknown/spec', { headers: auth(s) })).status).toBe(404);
      expect((await send(s, `/api/creations/${id}/spec`)).status).toBe(401);
    });
  });

  it('replays a stream from a sequence number, with heartbeats', async () => {
    const steps = parseRecording(
      ['{"do":"session","phase":"started"}', '{"do":"flow","step":"idea","phase":"started"}', '{"do":"wait","ms":300}',
        '{"do":"flow","step":"idea","phase":"finished","outcome":"ok"}', '{"do":"session","phase":"finished","outcome":"completed"}'].join('\n'),
    );
    const s = await start({ runner: new FakeRunner({ steps }), heartbeatMs: 20 });
    const id = await create(s);
    const live = await send(s, `/api/creations/${id}/stream?from=0`, { headers: auth(s) });
    expect(parseSse(live.body).some((f) => f.comment === 'heartbeat')).toBe(true);
    const all = parseSse(live.body).filter((f) => f.id !== undefined);

    // After the end, a reconnect from seq 3 (also through Last-Event-ID) gets exactly the rest.
    const later = await send(s, `/api/creations/${id}/stream?from=3`, { headers: auth(s) });
    expect(parseSse(later.body).filter((f) => f.id !== undefined)).toEqual(all.slice(3));
    const byHeader = await send(s, `/api/creations/${id}/stream`, { headers: { ...auth(s), 'last-event-id': '3' } });
    expect(parseSse(byHeader.body).filter((f) => f.id !== undefined)).toEqual(all.slice(3));

    const bad = await send(s, `/api/creations/${id}/stream?from=abc`, { headers: auth(s) });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ code: 'web.invalidQuery', params: { name: 'from', value: 'abc' } });
  });

  it('cancels a creation through the flow', async () => {
    const s = await start();
    const id = await create(s);
    await waitFor(async () => (await state(s, id)).pending);
    const reply = await post(s, `/api/creations/${id}/cancel`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ id, cancelling: true });
    const final = await waitFor(async () => {
      const st = await state(s, id);
      return st.status === 'finished' ? st : undefined;
    });
    expect(final.outcome).toBe('cancelled');
  });

  it('checks answers: unknown creation, wrong pending id, bad shape', async () => {
    const s = await start();
    const id = await create(s);
    const pending = await waitFor(async () => (await state(s, id)).pending);
    const missing = await post(s, '/api/creations/nope/answer', { pendingId: 'p1', answer: 'allow' });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ code: 'creation.notFound', params: { id: 'nope' } });
    expect((await send(s, '/api/creations/nope', { headers: auth(s) })).status).toBe(404);
    expect((await send(s, '/api/creations/nope/stream', { headers: auth(s) })).status).toBe(404);
    const wrong = await post(s, `/api/creations/${id}/answer`, { pendingId: 'p7', answer: {} });
    expect(wrong.status).toBe(409);
    expect(JSON.parse(wrong.body)).toMatchObject({ code: 'creation.wrongPending', params: { pendingId: 'p7', expected: pending.id } });
    const shape = await post(s, `/api/creations/${id}/answer`, { pendingId: pending.id, answer: 'allow' });
    expect(shape.status).toBe(400);
    expect(JSON.parse(shape.body)).toMatchObject({ code: 'creation.invalidAnswer', params: { kind: 'question' } });
  });

  it('checks request bodies: JSON only, at most 64 KB, valid shape, in the server language', async () => {
    const s = await start({ lang: 'es' });
    const plain = await send(s, '/api/creations', {
      method: 'POST',
      headers: { ...mutating(s), 'content-type': 'text/plain' },
      body: '{"idea":"x"}',
    });
    expect(plain.status).toBe(415);
    expect(JSON.parse(plain.body)).toMatchObject({ code: 'web.unsupportedMediaType', params: { contentType: 'text/plain' } });

    const big = await send(s, '/api/creations', {
      method: 'POST',
      headers: mutating(s),
      body: JSON.stringify({ idea: 'x'.repeat(70 * 1024) }),
    });
    expect(big.status).toBe(413);
    expect(JSON.parse(big.body)).toMatchObject({ code: 'web.bodyTooLarge', params: { limit: 65536 } });

    const broken = await send(s, '/api/creations', { method: 'POST', headers: mutating(s), body: '{"idea":' });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body)).toMatchObject({ code: 'web.invalidJson' });

    const invalid = await post(s, '/api/creations', { idea: '   ' });
    expect(invalid.status).toBe(400);
    const body = JSON.parse(invalid.body) as { code: string; message: string };
    expect(body.code).toBe('web.invalidBody');
    expect(body.message).toContain('El cuerpo de la petición no es válido');
    expect((await post(s, '/api/creations', { idea: 'x', extra: 1 })).status).toBe(400);

    // Nothing was created by the refused requests.
    const list = JSON.parse((await send(s, '/api/creations', { headers: auth(s) })).body) as { creations: unknown[] };
    expect(list.creations).toEqual([]);
  });

  it('keeps every security check on the creation routes', async () => {
    const s = await start();
    const json = { 'content-type': 'application/json' };
    const body = JSON.stringify({ idea: 'x' });
    // Cross-origin POST with a valid token.
    const foreign = await send(s, '/api/creations', {
      method: 'POST',
      headers: { ...auth(s), ...json, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body,
    });
    expect(foreign.status).toBe(403);
    const noToken = await send(s, '/api/creations', { method: 'POST', headers: { ...json, origin: s.origin }, body });
    expect(noToken.status).toBe(401);
    expect((await send(s, '/api/creations', { headers: { ...auth(s), host: 'evil.example' } })).status).toBe(403);
    expect((await send(s, '/api/creations/x/stream')).status).toBe(401);
    expect(manager?.list()).toEqual([]);
  });
});

describe('router', () => {
  const handler = () => undefined;
  const route = createRouter([
    ['GET /api/health', handler],
    ['GET /api/creations/:id', handler],
    ['POST /api/creations/:id/answer', handler],
  ]);

  it('matches exact routes and decoded path parameters', () => {
    expect(route('GET', '/api/health')?.params).toEqual({});
    expect(route('GET', '/api/creations/a%20b')?.params).toEqual({ id: 'a b' });
    expect(route('POST', '/api/creations/c1/answer')?.params).toEqual({ id: 'c1' });
  });

  it('does not match a wrong method, an empty or badly encoded segment, or extra segments', () => {
    expect(route('POST', '/api/health')).toBeUndefined();
    expect(route('GET', '/api/creations/c1/answer')).toBeUndefined();
    expect(route('GET', '/api/creations/')).toBeUndefined();
    expect(route('GET', '/api/creations/%E0%A4%A')).toBeUndefined();
    expect(route('GET', '/api/creations/c1/x')).toBeUndefined();
  });
});

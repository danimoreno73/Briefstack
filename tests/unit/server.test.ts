import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { BriefstackError } from '../../src/errors.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import type { AuthMode } from '../../src/creation/claudeAccount.js';
import type { ClaudeCheck } from '../../src/creation/claudeBinary.js';
import { FakeRunner } from '../../src/creation/fakeRunner.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { writeRunRecord } from '../../src/creation/runFiles.js';
import { appendEvent, sessionLifecycleEvent } from '../../src/events/index.js';
import { VERSION } from '../../src/version.js';
import { tempDir, writeTree } from '../helpers.js';

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

const UI = {
  'index.html': '<html><head><!-- importmap --><script type="module" src="/ui/main.js"></script></head></html>',
  'ui/main.js': 'export {};\n',
  'style.css': 'body {}\n',
  'fonts/face.woff2': 'wOF2',
  'notes.txt': 'not a served type\n',
};

describe('web server', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer | undefined;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web'));
    await writeTree(path.join(dir, 'ui'), UI);
    await writeTree(dir, { 'secret.txt': 'outside the UI folder\n' });
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await cleanup();
  });

  const start = async () => {
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: 't'.repeat(43) });
    return server;
  };
  const withToken = (s: WebServer, extra: Record<string, string> = {}) => ({ [TOKEN_HEADER]: s.token, ...extra });

  it('listens on 127.0.0.1 only and gives a URL with the token', async () => {
    const s = await start();
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/#token=${s.token}`);
  });

  it('serves the page with the import map and a CSP that allows it by hash', async () => {
    const s = await start();
    const reply = await send(s, '/');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('<script type="importmap">{"imports":{"preact":"/vendor/preact.mjs"');
    const csp = String(reply.headers['content-security-policy']);
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves vendored preact and UI files, nothing else', async () => {
    const s = await start();
    const preact = await send(s, '/vendor/preact.mjs');
    expect(preact.status).toBe(200);
    expect(preact.headers['content-type']).toContain('text/javascript');
    const markdown = await send(s, '/vendor/markdown-it.mjs');
    expect(markdown.status).toBe(200);
    expect(markdown.body).toContain('export');
    expect((await send(s, '/ui/main.js')).status).toBe(200);
    const font = await send(s, '/fonts/face.woff2');
    expect(font.status).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect((await send(s, '/notes.txt')).status).toBe(404);
    expect((await send(s, '/../secret.txt')).status).toBe(404);
    expect((await send(s, '/%2e%2e/secret.txt')).status).toBe(404);
    expect((await send(s, '/ui/..%5c..%5csecret.txt')).status).toBe(404);
    expect((await send(s, '/%E0%A4%A')).status).toBe(404);
    expect((await send(s, '/', { method: 'POST' })).status).toBe(405);
  });

  it('rejects a wrong Host header (DNS rebinding)', async () => {
    const s = await start();
    expect((await send(s, '/', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await send(s, '/', { headers: { host: `evil.example:${s.port}` } })).status).toBe(403);
    expect((await send(s, '/api/health', { headers: withToken(s, { host: 'evil.example' }) })).status).toBe(403);
  });

  it('needs the token on every API call', async () => {
    const s = await start();
    expect((await send(s, '/api/health')).status).toBe(401);
    expect((await send(s, '/api/health', { headers: { [TOKEN_HEADER]: 'x'.repeat(43) } })).status).toBe(401);
    const ok = await send(s, '/api/health', { headers: withToken(s) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, version: VERSION });
  });

  it('needs our own origin on mutating API calls (CSRF)', async () => {
    const s = await start();
    expect((await send(s, '/api/health', { method: 'POST', headers: withToken(s) })).status).toBe(403);
    const foreign = withToken(s, { origin: 'https://evil.example' });
    expect((await send(s, '/api/health', { method: 'POST', headers: foreign })).status).toBe(403);
    const crossSite = withToken(s, { origin: s.origin, 'sec-fetch-site': 'cross-site' });
    expect((await send(s, '/api/health', { method: 'POST', headers: crossSite })).status).toBe(403);
    // Passes every check; the route just does not exist.
    const own = withToken(s, { origin: s.origin, 'sec-fetch-site': 'same-origin' });
    expect((await send(s, '/api/health', { method: 'POST', headers: own })).status).toBe(404);
  });

  it('logs method, route and status only', async () => {
    const lines: string[] = [];
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), log: (line) => lines.push(line) });
    await send(server, '/api/health?x=secret-value', { headers: { [TOKEN_HEADER]: server.token } });
    expect(lines).toEqual(['GET /api/health 200']);
  });

  it('reports a missing UI build', async () => {
    await expect(startWebServer({ port: 0, uiDir: path.join(dir, 'missing') })).rejects.toMatchObject({
      code: 'web.uiNotBuilt',
    });
  });

  it('reports a port that is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const error = await startWebServer({ port, uiDir: path.join(dir, 'ui') }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BriefstackError);
      expect(error).toMatchObject({ code: 'web.portInUse', params: { port } });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('briefstack web', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-cli'));
    await writeTree(path.join(dir, 'ui'), UI);
  });
  afterEach(() => cleanup());

  const compatible = async (): Promise<ClaudeCheck> => ({
    status: 'compatible',
    executable: 'claude',
    installed: [2, 1, 300],
    expected: [2, 1, 286],
  });

  const io = (
    out: string[],
    err: string[],
    untilStopped: () => Promise<void>,
    lang = 'en',
    checkClaude: () => Promise<ClaudeCheck> = compatible,
    readAuthMode: () => Promise<AuthMode> = async () => ({ kind: 'signIn', plan: 'Claude Pro' }),
  ): CliIO => ({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd: dir,
    repoDir: path.join(dir, 'repo'),
    uiDir: path.join(dir, 'ui'),
    untilStopped,
    checkClaude,
    readAuthMode,
    pathEnv: {
      env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: lang },
      homedir: path.join(dir, 'user'),
      pathApi: path,
      caseInsensitive: process.platform !== 'linux',
    },
  });

  describe('creations', () => {
    /** Runs `web` until `stop()`, and gives the address it printed. */
    const runWeb = async (runner?: FakeRunner, events?: EventEmitter) => {
      const out: string[] = [];
      const err: string[] = [];
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => (stop = resolve));
      const options: CliIO = { ...io(out, err, () => stopped), ...(runner === undefined ? {} : { creationRunner: runner }) };
      if (events !== undefined) {
        // With an emitter, signals and crashes come from it, as from `process`.
        delete options.untilStopped;
        options.processEvents = events;
      }
      const done = main(['web', '--port', '0'], options);
      for (let i = 0; i < 200 && out[1] === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      const url = new URL(out[1] ?? 'http://127.0.0.1:1/');
      const token = url.hash.replace('#token=', '');
      const call = (method: string, route: string, body?: unknown): Promise<Reply> =>
        new Promise((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: Number(url.port),
              path: route,
              method,
              headers: {
                host: url.host,
                [TOKEN_HEADER]: token,
                origin: url.origin,
                'sec-fetch-site': 'same-origin',
                'content-type': 'application/json',
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => (text += chunk));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
            },
          );
          req.on('error', reject);
          req.end(body === undefined ? undefined : JSON.stringify(body));
        });
      return { call, stop, done, err };
    };

    it('answers the creation routes instead of 503, with the real runner unless a test passes one', async () => {
      const { call, stop, done } = await runWeb();
      const listed = await call('GET', '/api/creations');
      expect(listed.status).toBe(200);
      expect(JSON.parse(listed.body)).toEqual({ creations: [] });
      stop();
      expect(await done).toBe(0);
    });

    it('closes a running creation as interrupted when the server stops, before the server goes', async () => {
      const runner = await FakeRunner.fromFile(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings', 'full.jsonl'));
      const { call, stop, done } = await runWeb(runner);
      const created = JSON.parse((await call('POST', '/api/creations', { idea: 'A garden planner' })).body) as { id: string };
      let state: { status: string; sessionId?: string } = { status: 'running' };
      for (let i = 0; i < 200 && state.status !== 'waiting'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = JSON.parse((await call('GET', `/api/creations/${created.id}`)).body) as typeof state;
      }
      expect(state.status).toBe('waiting');
      const session = state.sessionId as string;
      stop();
      expect(await done).toBe(0);
      const events = await readFile(path.join(dir, 'home', 'sessions', session, 'events.jsonl'), 'utf8');
      expect(events).toContain('"reason":"server_stop"');
      expect(events).not.toContain('session.finished');
    });

    it('handles an error nothing caught as a stop: running creations are closed and it exits with 1', async () => {
      const runner = await FakeRunner.fromFile(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings', 'full.jsonl'));
      const events = new EventEmitter();
      const { call, done, err } = await runWeb(runner, events);
      const created = JSON.parse((await call('POST', '/api/creations', { idea: 'A garden planner' })).body) as { id: string };
      let state: { status: string; sessionId?: string } = { status: 'running' };
      for (let i = 0; i < 200 && state.status !== 'waiting'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = JSON.parse((await call('GET', `/api/creations/${created.id}`)).body) as typeof state;
      }
      expect(state.status).toBe('waiting');
      events.emit('unhandledRejection', new Error('lost promise'));
      // A second error during the shutdown is reported and does not stop it.
      events.emit('uncaughtException', new Error('second one'));
      expect(await done).toBe(1);
      expect(err.join('\n')).toContain('lost promise');
      expect(err.join('\n')).toContain('second one');
      const file = await readFile(path.join(dir, 'home', 'sessions', state.sessionId as string, 'events.jsonl'), 'utf8');
      expect(file).toContain('"reason":"server_stop"');
      // Everything was removed from the emitter once the shutdown ended.
      expect(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((name) => events.listenerCount(name))).toEqual([0, 0, 0, 0]);
    });
  });

  it('cleans up after a server that died with a creation running, before it serves anything', async () => {
    // A pid that existed and is gone: a process that already ended.
    const gone = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.on('exit', () => resolve(child.pid ?? 0));
    });
    const creation = '0b0e4c1a-1111-4a5b-9c8d-123456789abc';
    const session = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';
    const sessionsDir = path.join(dir, 'home', 'sessions');
    await appendEvent(sessionsDir, sessionLifecycleEvent(session, 'started'));
    await writeRunRecord(path.join(dir, 'home', 'runs'), {
      v: 1,
      creationId: creation,
      claude: { pid: gone, start: 'x' },
      server: { pid: gone, start: 'y' },
      sessionId: session,
      startedAt: new Date().toISOString(),
    });
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(['web', '--port', '0'], io(out, err, async () => undefined))).toBe(0);
    expect(err.join('\n')).toContain(`Session ${session} was closed as interrupted.`);
    expect(await readFile(path.join(sessionsDir, session, 'events.jsonl'), 'utf8')).toContain('"reason":"server_crash"');
    expect(await readdir(path.join(dir, 'home', 'runs'))).toEqual([]);
  });

  it('prints the URL alone on its own line and stops cleanly', async () => {
    const out: string[] = [];
    const err: string[] = [];
    let seen = '';
    const code = await main(
      ['web', '--port', '0'],
      io(out, err, async () => {
        seen = out[1] ?? '';
      }),
    );
    expect(code).toBe(0);
    expect(out[0]).toContain('Open this address');
    expect(seen).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
    expect(out[2]).toContain('Claude Code: signed in');
    expect(out[3]).toBe('briefstack web stopped.');
  });

  it('warns when Claude Code is missing or not compatible', async () => {
    const cases: [ClaudeCheck, string][] = [
      [{ status: 'notFound' }, 'Claude Code was not found'],
      [{ status: 'older', executable: 'c', installed: [2, 1, 200], expected: [2, 1, 286] }, 'Claude Code 2.1.200 is older than the 2.1.286'],
      [{ status: 'untested', executable: 'c', installed: [2, 2, 0], expected: [2, 1, 286] }, 'Claude Code 2.2.0 has not been tested'],
      [{ status: 'unknownVersion', executable: 'c' }, 'could not read the version of Claude Code'],
    ];
    for (const [check, text] of cases) {
      const out: string[] = [];
      const err: string[] = [];
      expect(await main(['web', '--port', '0'], io(out, err, async () => undefined, 'en', async () => check))).toBe(0);
      expect(err.join('\n')).toContain(text);
      expect(out[1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    }
    const quiet: string[] = [];
    await main(['web', '--port', '0'], io([], quiet, async () => undefined));
    expect(quiet.filter((line) => line.startsWith('Warning'))).toEqual([]);
  });

  it('says how Claude Code signs in, and what to do when it does not, in both languages', async () => {
    const cases: [string, AuthMode, 'out' | 'err', string][] = [
      ['en', { kind: 'signIn', plan: 'Claude Max' }, 'out', 'signed in with a Claude plan (Claude Max)'],
      ['en', { kind: 'apiKey', source: 'environment' }, 'out', 'API key (ANTHROPIC_API_KEY). Creations are billed per use'],
      ['en', { kind: 'apiKey', source: 'bearer' }, 'out', 'API key (ANTHROPIC_AUTH_TOKEN)'],
      ['en', { kind: 'cloud', provider: 'bedrock' }, 'out', 'cloud provider (bedrock)'],
      ['en', { kind: 'none' }, 'err', 'Run `claude` in a terminal and sign in'],
      ['en', { kind: 'unknown' }, 'err', 'could not ask Claude Code how it signs in'],
      ['es', { kind: 'apiKey', source: 'environment' }, 'out', 'clave de API (ANTHROPIC_API_KEY)'],
      ['es', { kind: 'none' }, 'err', 'inicia sesión con tu cuenta de Claude'],
    ];
    for (const [lang, mode, stream, text] of cases) {
      const out: string[] = [];
      const err: string[] = [];
      expect(await main(['web', '--port', '0'], io(out, err, async () => undefined, lang, compatible, async () => mode))).toBe(0);
      expect((stream === 'out' ? out : err).join('\n')).toContain(text);
    }
  });

  it('serves the Claude Code status without the executable path or any account detail, and reads it again on request', async () => {
    let reads = 0;
    const out: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const options = io(out, [], () => stopped, 'en', compatible, async () => {
      reads += 1;
      return { kind: 'apiKey', source: 'environment' };
    });
    const done = main(['web', '--port', '0'], options);
    for (let i = 0; i < 200 && out[1] === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const url = new URL(out[1] ?? '');
    const get = async (route: string) => {
      const reply = await fetch(`${url.origin}${route}`, { headers: { [TOKEN_HEADER]: url.hash.replace('#token=', '') } });
      return { status: reply.status, body: (await reply.json()) as unknown };
    };
    expect(await get('/api/claude')).toEqual({
      status: 200,
      body: { install: { status: 'compatible', installed: '2.1.300', expected: '2.1.286' }, mode: { kind: 'apiKey', source: 'environment' } },
    });
    expect(reads).toBe(1);
    await get('/api/claude?refresh=1');
    expect(reads).toBe(2);
    stop();
    expect(await done).toBe(0);
  });

  it('suggests --port 0 when the port is taken, in both languages', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = String((blocker.address() as { port: number }).port);
    try {
      for (const [lang, hint] of [
        ['en', 'Run again with --port 0'],
        ['es', 'Vuelve a ejecutarlo con --port 0'],
      ] as const) {
        const err: string[] = [];
        expect(await main(['web', '--port', port], io([], err, async () => undefined, lang))).toBe(1);
        expect(err.join('\n')).toContain(hint);
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('refuses a port that is not a number', async () => {
    const err: string[] = [];
    expect(await main(['web', '--port', 'abc'], io([], err, async () => undefined))).toBe(1);
    expect(err.join('\n')).toContain('"abc" is not a valid port');
    expect(await main(['web', '--port', '70000'], io([], err, async () => undefined))).toBe(1);
  });
});

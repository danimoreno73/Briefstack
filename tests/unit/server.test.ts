import { createServer } from 'node:net';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { BriefstackError } from '../../src/errors.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import type { ClaudeCheck } from '../../src/creation/claudeBinary.js';
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
    expect((await send(s, '/ui/main.js')).status).toBe(200);
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
  ): CliIO => ({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd: dir,
    repoDir: path.join(dir, 'repo'),
    uiDir: path.join(dir, 'ui'),
    untilStopped,
    checkClaude,
    pathEnv: {
      env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: lang },
      homedir: path.join(dir, 'user'),
      pathApi: path,
      caseInsensitive: process.platform !== 'linux',
    },
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
    expect(out[2]).toBe('briefstack web stopped.');
  });

  it('warns when Claude Code is missing or not compatible', async () => {
    const cases: [ClaudeCheck, string][] = [
      [{ status: 'notFound' }, 'Claude Code was not found'],
      [{ status: 'older', executable: 'c', installed: [2, 1, 200], expected: [2, 1, 286] }, 'Claude Code 2.1.200 is older than the 2.1.286'],
      [{ status: 'untested', executable: 'c', installed: [2, 2, 0], expected: [2, 1, 286] }, 'Claude Code 2.2.0 has not been tested'],
      [{ status: 'unknownVersion', executable: 'c' }, 'could not read the version of c'],
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

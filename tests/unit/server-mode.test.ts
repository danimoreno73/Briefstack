import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { CodexService } from '../../src/codex/service.js';
import type { ClaudeCheck } from '../../src/creation/claudeBinary.js';
import { matchesSecret, MIN_SECRET_LENGTH, parseAllowedNames, parseListen, readAccessSecret, serverModeOf, type ServerMode } from '../../src/server/access.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { checkRequest, expectedOrigin, isAllowedHost, isSameOrigin, parseAllowedName, type RequestHeaders } from '../../src/server/security.js';
import { writeRoutes } from '../../src/server/write.js';
import { tempDir, writeTree } from '../helpers.js';

// Phase 12, M1: server mode (PLAN-phase-12 §1, 1 to 3, 6b and 7). Local mode is pinned as it was.

const PORT = 4870;
const TOKEN = 'a'.repeat(43);
const NAME = 'box.example-tailnet.ts.net:8445';
// Built at run time: no file in the repo holds a secret-looking value.
const SECRET = ['s', '3'.repeat(MIN_SECRET_LENGTH + 4)].join('');

const headers = (overrides: Partial<RequestHeaders> = {}): RequestHeaders => ({
  method: 'GET',
  host: `127.0.0.1:${PORT}`,
  origin: undefined,
  secFetchSite: undefined,
  token: TOKEN,
  ...overrides,
});

describe('local mode, as before phase 12', () => {
  it('accepts only the loopback names: a configured name is nothing without server mode', () => {
    expect(isAllowedHost(NAME, PORT)).toBe(false);
    expect(checkRequest(headers({ host: NAME }), { port: PORT, token: TOKEN, api: true })).toBe('host');
  });

  it('needs the token on /api and an http origin on a mutating call', () => {
    expect(checkRequest(headers({ token: undefined }), { port: PORT, token: TOKEN, api: true })).toBe('token');
    expect(checkRequest(headers({ method: 'POST', origin: `https://127.0.0.1:${PORT}` }), { port: PORT, token: TOKEN, api: true })).toBe('origin');
    expect(checkRequest(headers({ method: 'POST', origin: `http://127.0.0.1:${PORT}`, secFetchSite: 'same-origin' }), { port: PORT, token: TOKEN, api: true })).toBeUndefined();
  });
});

describe('server mode checks', () => {
  const server = (open = false, signedIn = false) => ({ names: [NAME], open, signedIn });

  it('accepts the configured names besides the loopback ones, and nothing else', () => {
    expect(isAllowedHost(NAME, PORT, [NAME])).toBe(true);
    expect(isAllowedHost(NAME.toUpperCase(), PORT, [NAME])).toBe(true);
    expect(isAllowedHost(`127.0.0.1:${PORT}`, PORT, [NAME])).toBe(true);
    expect(isAllowedHost('box.example-tailnet.ts.net:8446', PORT, [NAME])).toBe(false);
    expect(isAllowedHost('evil.example:8445', PORT, [NAME])).toBe(false);
    expect(checkRequest(headers({ host: 'evil.example:8445' }), { port: PORT, token: TOKEN, api: false, server: server() })).toBe('host');
  });

  it('wants an https origin for a configured name and an http one for a loopback name', () => {
    expect(expectedOrigin(NAME, PORT, [NAME])).toBe(`https://${NAME}`);
    expect(expectedOrigin(`localhost:${PORT}`, PORT, [NAME])).toBe(`http://localhost:${PORT}`);
    expect(isSameOrigin(`https://${NAME}`, 'same-origin', NAME, PORT, [NAME])).toBe(true);
    expect(isSameOrigin(`http://${NAME}`, 'same-origin', NAME, PORT, [NAME])).toBe(false);
    expect(isSameOrigin(`https://${NAME}`, 'cross-site', NAME, PORT, [NAME])).toBe(false);
    expect(isSameOrigin('https://evil.example', undefined, NAME, PORT, [NAME])).toBe(false);
  });

  it('never accepts the token: /api needs a device session, but for its open routes', () => {
    expect(checkRequest(headers({ host: NAME }), { port: PORT, token: TOKEN, api: true, server: server() })).toBe('session');
    expect(checkRequest(headers({ host: NAME, token: undefined }), { port: PORT, token: TOKEN, api: true, server: server(true) })).toBeUndefined();
    expect(checkRequest(headers({ host: NAME, token: undefined }), { port: PORT, token: TOKEN, api: true, server: server(false, true) })).toBeUndefined();
    // A signed-in mutating call still needs its own origin.
    expect(checkRequest(headers({ host: NAME, method: 'POST', origin: 'https://evil.example' }), { port: PORT, token: TOKEN, api: true, server: server(false, true) })).toBe('origin');
    expect(checkRequest(headers({ host: NAME, method: 'POST', origin: `https://${NAME}` }), { port: PORT, token: TOKEN, api: true, server: server(false, true) })).toBeUndefined();
  });

  it('reads allowed names strictly', () => {
    expect(parseAllowedName(' Box.Example-Tailnet.ts.net:8445 ')).toBe(NAME);
    for (const bad of ['https://box.ts.net:8445', 'box.ts.net', 'box.ts.net:0', 'box.ts.net:70000', '*.ts.net:8445', 'box.ts.net:8445/x', 'a b:1', '-box.ts.net:1', 'user@box:1']) {
      expect(parseAllowedName(bad), bad).toBeUndefined();
    }
    expect(parseAllowedNames(`${NAME}, other.ts.net:443,${NAME}`)).toEqual([NAME, 'other.ts.net:443']);
    expect(parseAllowedNames(`${NAME},, other.ts.net:443,`)).toEqual([NAME, 'other.ts.net:443']);
    expect(() => parseAllowedNames(undefined)).toThrow(expect.objectContaining({ code: 'server.noAllowedHosts' }));
    expect(() => parseAllowedNames(' , ')).toThrow(expect.objectContaining({ code: 'server.noAllowedHosts' }));
    expect(() => parseAllowedNames('box.ts.net')).toThrow(expect.objectContaining({ code: 'server.invalidAllowedHost' }));
  });

  it('listens on an IP address only, the loopback one by default', () => {
    expect(parseListen(undefined)).toBe('127.0.0.1');
    expect(parseListen('0.0.0.0')).toBe('0.0.0.0');
    expect(parseListen('::')).toBe('::');
    expect(() => parseListen('example.com')).toThrow(expect.objectContaining({ code: 'server.invalidListen' }));
  });
});

describe('the access secret', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('secret')));
  afterEach(() => cleanup());

  it('is read from its file without the line end, kept as a digest, and compared in full', async () => {
    const file = path.join(dir, 'secret');
    await writeFile(file, `${SECRET}\r\n`, 'utf8');
    const read = await readAccessSecret(file);
    expect(read.digest).toHaveLength(32);
    expect(read.digest.toString('utf8')).not.toContain(SECRET);
    expect(matchesSecret(SECRET, read.digest)).toBe(true);
    expect(matchesSecret(`${SECRET}x`, read.digest)).toBe(false);
    expect(matchesSecret(SECRET.slice(0, -1), read.digest)).toBe(false);
    expect(matchesSecret('', read.digest)).toBe(false);
    // A byte-order mark from an editor is not part of the secret.
    await writeFile(file, `${String.fromCharCode(0xfeff)}${SECRET}\n`, 'utf8');
    expect(matchesSecret(SECRET, (await readAccessSecret(file)).digest)).toBe(true);
  });

  it('refuses a missing, short or multi-line file, naming the file and never its content', async () => {
    const short = path.join(dir, 'short');
    await writeFile(short, 'x'.repeat(MIN_SECRET_LENGTH - 1), 'utf8');
    const lines = path.join(dir, 'lines');
    await writeFile(lines, `${SECRET}\n${SECRET}\n`, 'utf8');
    await expect(readAccessSecret(path.join(dir, 'none'))).rejects.toMatchObject({ code: 'server.secretUnreadable', params: { file: path.join(dir, 'none') } });
    await expect(readAccessSecret(short)).rejects.toMatchObject({ code: 'server.secretTooShort' });
    const error = await readAccessSecret(lines).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'server.secretTooShort' });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')('warns when group or others can read the file', async () => {
    const file = path.join(dir, 'secret');
    await writeFile(file, SECRET, 'utf8');
    await chmod(file, 0o644);
    expect((await readAccessSecret(file)).open).toBe(true);
    await chmod(file, 0o600);
    expect((await readAccessSecret(file)).open).toBe(false);
    // Only reading counts: a group-writable but unreadable file is not "open".
    await chmod(file, 0o620);
    expect((await readAccessSecret(file)).open).toBe(false);
  });

  it('needs every server option', async () => {
    const file = path.join(dir, 'secret');
    await writeFile(file, SECRET, 'utf8');
    await expect(serverModeOf({ allowedHosts: NAME })).rejects.toMatchObject({ code: 'server.noSecretFile' });
    await expect(serverModeOf({ secretFile: file })).rejects.toMatchObject({ code: 'server.noAllowedHosts' });
    const mode = await serverModeOf({ allowedHosts: NAME, secretFile: file, listen: '0.0.0.0' });
    expect(mode).toMatchObject({ listen: '0.0.0.0', names: [NAME] });
  });
});

interface Reply {
  status: number;
  body: string;
}

function send(server: WebServer, urlPath: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: urlPath, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the web server in server mode', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer | undefined;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('server-mode'));
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html></html>', 'ui/main.js': 'export {};\n' });
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await cleanup();
  });
  const mode = (): ServerMode => ({ listen: '127.0.0.1', names: [NAME], secretDigest: Buffer.alloc(32), secretFileOpen: false });

  it('gives an address without the token, serves the page to its name, and refuses the token on /api', async () => {
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: TOKEN, server: mode() });
    expect(server.url).toBe(`https://${NAME}/`);
    expect(server.url).not.toContain(TOKEN);
    expect((await send(server, '/', { headers: { host: NAME } })).status).toBe(200);
    expect((await send(server, '/', { headers: { host: 'evil.example:8445' } })).status).toBe(403);
    const refused = await send(server, '/api/settings', { headers: { host: NAME, [TOKEN_HEADER]: TOKEN } });
    expect(refused).toMatchObject({ status: 401 });
    expect(JSON.parse(refused.body)).toEqual({ code: 'web.rejected.session' });
    expect((await send(server, '/api/health', { headers: { host: NAME } })).status).toBe(200);
    const state = await send(server, '/api/server/state', { headers: { host: NAME } });
    expect(JSON.parse(state.body)).toEqual({ mode: 'server', signedIn: false });
  });

  it('listens on 127.0.0.1 in local mode', async () => {
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: TOKEN });
    expect(server.address).toBe('127.0.0.1');
  });

  // Not on Windows: binding every address there can open the firewall's dialog on a desktop. CI's Linux and macOS prove it.
  it.skipIf(process.platform === 'win32')('listens on the --listen address in server mode', async () => {
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: TOKEN, server: { ...mode(), listen: '0.0.0.0' } });
    expect(server.address).toBe('0.0.0.0');
  });

  it('in local mode, the state route needs the token like any other and says local', async () => {
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: TOKEN });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/#token=${TOKEN}`);
    expect((await send(server, '/api/server/state')).status).toBe(401);
    expect(JSON.parse((await send(server, '/api/server/state', { headers: { [TOKEN_HEADER]: TOKEN } })).body)).toEqual({ mode: 'local' });
    expect((await send(server, '/', { headers: { host: NAME } })).status).toBe(403);
  });
});

describe('briefstack web --server', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-server'));
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html></html>', 'ui/main.js': 'export {};\n' });
    await mkdir(path.join(dir, 'repo'), { recursive: true });
  });
  afterEach(() => cleanup());

  const compatible = async (): Promise<ClaudeCheck> => ({ status: 'compatible', executable: 'claude', installed: [2, 1, 300], expected: [2, 1, 286] });
  const io = (out: string[], err: string[]): CliIO => ({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd: dir,
    repoDir: path.join(dir, 'repo'),
    uiDir: path.join(dir, 'ui'),
    untilStopped: async () => undefined,
    checkClaude: compatible,
    readAuthMode: async () => ({ kind: 'signIn', plan: 'Claude Pro' }),
    pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: 'en' }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' },
  });

  it('refuses a server option without --server', async () => {
    for (const option of ['--listen', '--allowed-hosts', '--access-secret-file']) {
      const err: string[] = [];
      expect(await main(['web', '--port', '0', option, 'x'], io([], err))).toBe(1);
      expect(err.join('\n')).toContain(`${option} is a server mode option`);
    }
  });

  it('refuses --server without its options', async () => {
    const err: string[] = [];
    expect(await main(['web', '--port', '0', '--server'], io([], err))).toBe(1);
    expect(err.join('\n')).toContain('--allowed-hosts');
  });

  it('starts with a warning, prints the address without a token, and never the secret', async () => {
    await writeFile(path.join(dir, 'secret'), `${SECRET}\n`, 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['web', '--port', '0', '--server', '--listen', '127.0.0.1', '--allowed-hosts', NAME, '--access-secret-file', 'secret'], io(out, err));
    expect(code).toBe(0);
    expect(out).toContain(`https://${NAME}/`);
    expect(out.join('\n')).toContain('sign in with the access secret');
    expect(err.join('\n')).toContain(`Warning: server mode. briefstack listens on 127.0.0.1:`);
    expect(`${out.join('\n')}\n${err.join('\n')}`).not.toContain(SECRET);
    expect(out.join('\n')).not.toContain('#token=');
  });
});

describe('Codex in server mode', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('codex-server')));
  afterEach(() => cleanup());

  it('is off whatever the config says, runs no check and gives no session', async () => {
    await writeTree(path.join(dir, 'home'), { 'config.json': JSON.stringify({ codexEnabled: true }) });
    const codex = new CodexService({ pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: dir, pathApi: path, caseInsensitive: false }, serverMode: true, locate: () => ({ file: 'codex', prefix: [] }) });
    expect(await codex.view()).toMatchObject({ available: false, reason: 'serverMode' });
    await expect(codex.check()).rejects.toMatchObject({ code: 'codex.serverMode' });
    expect(await codex.session()).toBeUndefined();
    expect(await codex.creationSession()).toBeUndefined();
  });

  // Review of M1, I2: Settings cannot turn it on, and its answer shows it off.
  const putSettings = async (body: unknown, serverMode: boolean): Promise<{ status: number; body: { codex?: { enabled: boolean } } }> => {
    const pathEnv = { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: dir, pathApi: path, caseInsensitive: false };
    const handler = new Map(writeRoutes({ pathEnv, ...(serverMode ? { serverMode: true } : {}) })).get('PUT /api/settings');
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });
    let status = 0;
    let text = '';
    const res = { writeHead: (code: number) => (status = code), end: (chunk?: string) => (text = chunk ?? '') };
    await handler?.(req as unknown as IncomingMessage, res as unknown as ServerResponse, {});
    return { status, body: JSON.parse(text) as { codex?: { enabled: boolean } } };
  };

  it('cannot be turned on from Settings in server mode, and shows as off there', async () => {
    await writeTree(path.join(dir, 'home'), { 'config.json': JSON.stringify({ codexEnabled: true }) });
    await expect(putSettings({ codexEnabled: true }, true)).rejects.toMatchObject({ code: 'codex.serverMode' });
    expect((await putSettings({ usageWarnWeek: 80 }, true)).body.codex?.enabled).toBe(false);
    expect((await putSettings({ usageWarnWeek: 80 }, false)).body.codex?.enabled).toBe(true);
  });
});

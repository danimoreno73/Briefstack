import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAccessSecret, MIN_SECRET_LENGTH, type ServerMode } from '../../src/server/access.js';
import { startWebServer, type WebServer } from '../../src/server/index.js';
import {
  clearedCookie,
  deviceLabel,
  DeviceSessions,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  sessionCookie,
  sessionToken,
  SIGN_IN_LIMIT,
  SIGN_IN_LOCK_MS,
  SIGN_IN_WINDOW_MS,
  SignInLimiter,
} from '../../src/server/sessions.js';
import { FakeChatRunner } from '../../src/chat/fakeChatRunner.js';
import { ChatManager } from '../../src/chat/manager.js';
import { ChatStore } from '../../src/chat/store.js';
import { chatWorld, type ChatWorld } from '../chatWorld.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

// Phase 12, M2: the access secret and device sessions (PLAN-phase-12 §1, 3 to 6).

const NAME = 'box.example-tailnet.ts.net:8445';
// Built at run time: no file in the repo holds a secret-looking value.
const SECRET = ['s', '7'.repeat(MIN_SECRET_LENGTH + 4)].join('');

/** A clock the tests move. */
function clock(start = Date.parse('2026-11-27T10:00:00Z')) {
  let at = start;
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) };
}

describe('the session cookie', () => {
  it('is __Host-, HttpOnly, Secure, SameSite=Strict, on Path=/ with no Domain, kept 400 days', () => {
    const token = 'A'.repeat(43);
    const cookie = sessionCookie(token);
    expect(cookie.startsWith(`${SESSION_COOKIE}=${token};`)).toBe(true);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${SESSION_MAX_AGE_S}`]) expect(cookie.split('; ')).toContain(part);
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(clearedCookie().split('; ')).toEqual(expect.arrayContaining([`${SESSION_COOKIE}=`, 'Max-Age=0', 'Path=/', 'Secure', 'HttpOnly']));
  });

  it('is read back from a Cookie header only when it has the shape of a token', () => {
    const token = 'b'.repeat(43);
    expect(sessionToken(`other=1; ${SESSION_COOKIE}=${token}; x=y`)).toBe(token);
    expect(sessionToken(`${SESSION_COOKIE}=short`)).toBeUndefined();
    expect(sessionToken(`${SESSION_COOKIE}=${token}x`)).toBeUndefined();
    expect(sessionToken('briefstack-session=' + token)).toBeUndefined();
    expect(sessionToken(undefined)).toBeUndefined();
  });

  it('labels a device by its User-Agent, without control characters, at most 120 characters', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone)\r\nX-Evil: 1')).toBe('Mozilla/5.0 (iPhone) X-Evil: 1');
    expect(deviceLabel('x'.repeat(300))).toHaveLength(120);
    // None sent: empty, and the page names it in the user's language.
    expect(deviceLabel(undefined)).toBe('');
  });
});

describe('device sessions', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('sessions')));
  afterEach(() => cleanup());

  it('keep only the digest of a token, across a restart', async () => {
    const file = path.join(dir, 'server', 'sessions.json');
    const sessions = await DeviceSessions.open({ file });
    const { token, device } = await sessions.signIn('Phone');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain(device.digest);
    const again = await DeviceSessions.open({ file });
    expect((await again.find(token))?.id).toBe(device.id);
    expect(await again.find('c'.repeat(43))).toBeUndefined();
    expect(again.list(device.id)).toEqual([{ id: device.id, label: 'Phone', createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, current: true }]);
    expect(JSON.stringify(again.list(undefined))).not.toContain(device.digest);
  });

  it.skipIf(process.platform === 'win32')('write their file readable by its owner only', async () => {
    const file = path.join(dir, 'sessions.json');
    await (await DeviceSessions.open({ file })).signIn('PC');
    expect((await stat(file)).mode & 0o077).toBe(0);
  });

  it('read a broken file as nobody signed in', async () => {
    const file = path.join(dir, 'sessions.json');
    await writeFile(file, '{ not json', 'utf8');
    expect((await DeviceSessions.open({ file })).list(undefined)).toEqual([]);
    await writeFile(file, JSON.stringify({ v: 1, devices: [{ id: 'x', digest: 'short', label: 'l', createdAt: 'a', lastSeenAt: 'b' }] }), 'utf8');
    expect((await DeviceSessions.open({ file })).list(undefined)).toEqual([]);
  });

  it('note the last use at most once a minute', async () => {
    const time = clock();
    const file = path.join(dir, 'sessions.json');
    const sessions = await DeviceSessions.open({ file, now: time.now });
    const { token, device } = await sessions.signIn('PC');
    time.advance(30_000);
    expect((await sessions.find(token))?.lastSeenAt).toBe(device.lastSeenAt);
    time.advance(40_000);
    const seen = await sessions.find(token);
    expect(seen?.lastSeenAt).toBe(time.now().toISOString());
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt).toBe(time.now().toISOString());
  });

  it('forget a device unused for longer than a cookie lives, also across a restart', async () => {
    const time = clock();
    const file = path.join(dir, 'sessions.json');
    const sessions = await DeviceSessions.open({ file, now: time.now });
    const old = await sessions.signIn('Old phone');
    time.advance(SESSION_MAX_AGE_S * 1000 + 1000);
    expect(await sessions.find(old.token)).toBeUndefined();
    expect(sessions.list(undefined)).toEqual([]);
    expect((await DeviceSessions.open({ file, now: time.now })).list(undefined)).toEqual([]);
  });

  it('say when their file does not read back, and change nothing when a write fails', async () => {
    const file = path.join(dir, 'sessions.json');
    await writeFile(file, '{ not json', 'utf8');
    let unreadable = 0;
    await DeviceSessions.open({ file, onUnreadable: () => (unreadable += 1) });
    expect(unreadable).toBe(1);
    await DeviceSessions.open({ file: path.join(dir, 'missing.json'), onUnreadable: () => (unreadable += 1) });
    expect(unreadable).toBe(1);

    // The file's folder turns into a file: every later write fails.
    const blocked = path.join(dir, 'blocked', 'sessions.json');
    const sessions = await DeviceSessions.open({ file: blocked });
    const kept = await sessions.signIn('PC');
    await rm(path.join(dir, 'blocked'), { recursive: true });
    await writeFile(path.join(dir, 'blocked'), 'not a folder', 'utf8');
    await expect(sessions.revoke(kept.device.id)).rejects.toThrow();
    expect((await sessions.find(kept.token))?.id).toBe(kept.device.id);
    await expect(sessions.signIn('Phone')).rejects.toThrow();
    expect(sessions.list(undefined)).toHaveLength(1);
  });

  it('report the devices they sign out', async () => {
    const revoked: string[][] = [];
    const sessions = await DeviceSessions.open({ file: path.join(dir, 'sessions.json'), onRevoked: (ids) => revoked.push([...ids]) });
    const a = await sessions.signIn('A');
    const b = await sessions.signIn('B');
    await sessions.revoke(a.device.id);
    await sessions.revoke('none');
    await sessions.revokeAll();
    expect(revoked).toEqual([[a.device.id], [b.device.id]]);
  });

  it('revoke one device, or all of them', async () => {
    const sessions = await DeviceSessions.open({ file: path.join(dir, 'sessions.json') });
    const phone = await sessions.signIn('Phone');
    const pc = await sessions.signIn('PC');
    expect(await sessions.revoke(phone.device.id)).toBe(true);
    expect(await sessions.revoke(phone.device.id)).toBe(false);
    expect(await sessions.find(phone.token)).toBeUndefined();
    expect((await sessions.find(pc.token))?.id).toBe(pc.device.id);
    await sessions.revokeAll();
    expect(await sessions.find(pc.token)).toBeUndefined();
    expect(sessions.list(undefined)).toEqual([]);
  });
});

describe('the sign-in limit', () => {
  it(`locks every sign-in after ${SIGN_IN_LIMIT} failures in 15 minutes, for 15 minutes`, () => {
    const time = clock();
    const limiter = new SignInLimiter(time.now);
    for (let i = 0; i < SIGN_IN_LIMIT - 1; i++) limiter.fail();
    expect(limiter.locked()).toBeUndefined();
    limiter.fail();
    expect(limiter.locked()).toBe(SIGN_IN_LOCK_MS / 1000);
    time.advance(SIGN_IN_LOCK_MS - 1000);
    expect(limiter.locked()).toBe(1);
    time.advance(1000);
    expect(limiter.locked()).toBeUndefined();
  });

  it('forgets failures older than its window, and all of them after a good sign-in', () => {
    const time = clock();
    const limiter = new SignInLimiter(time.now);
    for (let i = 0; i < SIGN_IN_LIMIT - 1; i++) limiter.fail();
    time.advance(SIGN_IN_WINDOW_MS);
    limiter.fail();
    expect(limiter.locked()).toBeUndefined();
    for (let i = 0; i < SIGN_IN_LIMIT - 2; i++) limiter.fail();
    limiter.succeed();
    limiter.fail();
    expect(limiter.locked()).toBeUndefined();
  });
});

interface Reply {
  status: number;
  body: string;
  setCookie: string[];
}

function send(server: WebServer, urlPath: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path: urlPath, method: options.method ?? 'GET', headers: { host: NAME, ...options.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers['set-cookie'] ?? [] }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** A mutating call from the page, with its origin. */
const post = (server: WebServer, urlPath: string, body: unknown, cookie?: string): Promise<Reply> =>
  send(server, urlPath, {
    method: 'POST',
    headers: { origin: `https://${NAME}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'user-agent': 'Test browser', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });

const cookieOf = (reply: Reply): string => {
  const first = reply.setCookie[0] ?? '';
  return first.split(';')[0] ?? '';
};

describe('the web server signs devices in', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer | undefined;
  let logLines: string[];
  let time: ReturnType<typeof clock>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('server-signin'));
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html></html>', 'ui/main.js': 'export {};\n' });
    await writeFile(path.join(dir, 'secret'), `${SECRET}\n`, 'utf8');
    const read = await readAccessSecret(path.join(dir, 'secret'));
    const mode: ServerMode = { listen: '127.0.0.1', names: [NAME], secretDigest: read.digest, secretFileOpen: false };
    logLines = [];
    time = clock();
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      server: mode,
      now: time.now,
      log: (line) => logLines.push(line),
      pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: false },
    });
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await cleanup();
  });

  it('gives a cookie for the right secret, and the cookie opens /api', async () => {
    const s = server as WebServer;
    const signed = await post(s, '/api/server/sign-in', { secret: SECRET });
    expect(signed.status).toBe(200);
    expect(signed.setCookie[0]).toContain('HttpOnly');
    const cookie = cookieOf(signed);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(signed.body).not.toContain(cookie.split('=')[1] ?? '?');
    expect((await send(s, '/api/settings', { headers: { cookie } })).status).toBe(200);
    expect(JSON.parse((await send(s, '/api/server/state', { headers: { cookie } })).body)).toEqual({ mode: 'server', signedIn: true });
    const devices = JSON.parse((await send(s, '/api/server/devices', { headers: { cookie } })).body) as { devices: { label: string; current: boolean }[] };
    expect(devices.devices).toEqual([expect.objectContaining({ label: 'Test browser', current: true })]);
    // The sessions file keeps no token.
    expect(await readFile(path.join(dir, 'home', 'server', 'sessions.json'), 'utf8')).not.toContain(cookie.split('=')[1] ?? '?');
  });

  it('refuses a wrong secret, a malformed body and a missing origin, and never repeats the secret', async () => {
    const s = server as WebServer;
    const wrong = await post(s, '/api/server/sign-in', { secret: `${SECRET}x` });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body)).toMatchObject({ code: 'server.signInFailed' });
    expect(wrong.setCookie).toEqual([]);
    const malformed = await send(s, '/api/server/sign-in', { method: 'POST', headers: { origin: `https://${NAME}`, 'content-type': 'application/json' }, body: `{"secret":"${SECRET}` });
    expect(malformed.status).toBe(400);
    expect(malformed.body).not.toContain(SECRET);
    const noOrigin = await send(s, '/api/server/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }) });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.setCookie).toEqual([]);
    const otherOrigin = await send(s, '/api/server/sign-in', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }) });
    expect(otherOrigin.status).toBe(403);
  });

  it('refuses a sign-in body over its limit without reading it all, and compares secrets of any length', async () => {
    const s = server as WebServer;
    const huge = await post(s, '/api/server/sign-in', { secret: 'x'.repeat(10_000) });
    expect(huge.status).toBe(413);
    // Lengths that differ from the secret's answer "wrong", never an error from the compare.
    for (const secret of ['a', SECRET.slice(0, 31), `${SECRET}${SECRET}`, 'é'.repeat(50)]) {
      expect((await post(s, '/api/server/sign-in', { secret })).status, secret.length.toString()).toBe(401);
    }
  });

  it('looks no session up for a refused host', async () => {
    const s = server as WebServer;
    const signed = await post(s, '/api/server/sign-in', { secret: SECRET });
    const file = path.join(dir, 'home', 'server', 'sessions.json');
    const before = await readFile(file, 'utf8');
    time.advance(5 * 60_000);
    expect((await send(s, '/api/settings', { headers: { host: 'evil.example:8445', cookie: cookieOf(signed) } })).status).toBe(403);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('locks sign-in after five failures, the right secret included, until the lock ends', async () => {
    const s = server as WebServer;
    for (let i = 0; i < SIGN_IN_LIMIT; i++) expect((await post(s, '/api/server/sign-in', { secret: 'wrong' })).status).toBe(401);
    const locked = await post(s, '/api/server/sign-in', { secret: SECRET });
    expect(locked.status).toBe(429);
    expect(JSON.parse(locked.body)).toMatchObject({ code: 'server.signInLocked', params: { seconds: SIGN_IN_LOCK_MS / 1000 } });
    expect(locked.setCookie).toEqual([]);
    time.advance(SIGN_IN_LOCK_MS);
    expect((await post(s, '/api/server/sign-in', { secret: SECRET })).status).toBe(200);
  });

  it('signs this device out, revokes another, and revokes all', async () => {
    const s = server as WebServer;
    const pc = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    const phone = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    const tablet = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));

    const out = await post(s, '/api/server/sign-out', {}, phone);
    expect(out.status).toBe(200);
    expect(out.setCookie[0]).toContain('Max-Age=0');
    expect((await send(s, '/api/settings', { headers: { cookie: phone } })).status).toBe(401);

    const list = JSON.parse((await send(s, '/api/server/devices', { headers: { cookie: pc } })).body) as { devices: { id: string; current: boolean }[] };
    expect(list.devices).toHaveLength(2);
    const other = list.devices.find((device) => !device.current);
    expect((await post(s, `/api/server/devices/${other?.id ?? ''}/revoke`, {}, pc)).status).toBe(200);
    expect((await send(s, '/api/settings', { headers: { cookie: tablet } })).status).toBe(401);
    expect(JSON.parse((await post(s, '/api/server/devices/nope/revoke', {}, pc)).body)).toMatchObject({ code: 'server.deviceNotFound' });

    const all = await post(s, '/api/server/devices/revoke-all', {}, pc);
    expect(all.setCookie[0]).toContain('Max-Age=0');
    expect((await send(s, '/api/settings', { headers: { cookie: pc } })).status).toBe(401);
  });

  it('keeps devices signed in across a restart of the server', async () => {
    const s = server as WebServer;
    const cookie = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    await s.close();
    const read = await readAccessSecret(path.join(dir, 'secret'));
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      server: { listen: '127.0.0.1', names: [NAME], secretDigest: read.digest, secretFileOpen: false },
      pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: false },
    });
    expect((await send(server, '/api/settings', { headers: { cookie } })).status).toBe(200);
  });

  it('puts neither the secret nor a session token in a log line or an answer', async () => {
    const s = server as WebServer;
    const signed = await post(s, '/api/server/sign-in', { secret: SECRET });
    const token = cookieOf(signed).split('=')[1] ?? '?';
    const answers = [signed.body];
    await post(s, '/api/server/sign-in', { secret: `${SECRET}y` });
    answers.push((await send(s, '/api/server/devices', { headers: { cookie: cookieOf(signed) } })).body);
    answers.push((await send(s, '/api/server/state', { headers: { cookie: cookieOf(signed) } })).body);
    const everything = [...logLines, ...answers].join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(token);
  });

  it('never accepts the session cookie in local mode', async () => {
    const s = server as WebServer;
    const cookie = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    await s.close();
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 'a'.repeat(43),
      pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: false },
    });
    const refused = await send(server, '/api/settings', { headers: { host: `127.0.0.1:${server.port}`, cookie } });
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body)).toEqual({ code: 'web.rejected.token' });
    expect((await send(server, '/api/server/sign-in', { method: 'POST', headers: { host: `127.0.0.1:${server.port}` } })).status).toBe(401);
  });
});

describe('signing a device out ends its open streams', () => {
  let world: ChatWorld;
  let chat: ChatManager | undefined;
  let server: WebServer | undefined;
  beforeEach(async () => {
    world = await chatWorld();
    await writeTree(path.join(world.dir, 'ui'), { 'index.html': '<html></html>' });
    await writeFile(path.join(world.dir, 'secret'), SECRET, 'utf8');
    chat = await ChatManager.open({ store: new ChatStore(path.join(world.home, 'chat')), runner: new FakeChatRunner({ turns: [] }), tools: world.tools, profile: async () => ({ model: 'haiku', effort: 'low' }) });
    const read = await readAccessSecret(path.join(world.dir, 'secret'));
    server = await startWebServer({
      port: 0,
      uiDir: path.join(world.dir, 'ui'),
      pathEnv: world.pathEnv,
      repoDir: world.repoDir,
      chat,
      heartbeatMs: 50,
      server: { listen: '127.0.0.1', names: [NAME], secretDigest: read.digest, secretFileOpen: false },
    });
  });
  afterEach(async () => {
    await chat?.shutdown();
    await server?.close();
    await world.cleanup();
  });

  /** Opens the chat's stream and resolves `ended` when the server ends it. */
  const openStream = (s: WebServer, cookie: string): Promise<{ status: number; ended: Promise<void> }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.port, path: '/api/chat/stream?from=0', headers: { host: NAME, cookie } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, ended: new Promise((done) => res.once('end', () => done())) });
      });
      req.on('error', reject);
      req.end();
    });

  it.each(['revoke', 'sign-out', 'revoke-all'])('after %s', async (how) => {
    const s = server as WebServer;
    const phone = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    const pc = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    const stream = await openStream(s, phone);
    expect(stream.status).toBe(200);
    if (how === 'sign-out') {
      expect((await post(s, '/api/server/sign-out', {}, phone)).status).toBe(200);
    } else if (how === 'revoke-all') {
      expect((await post(s, '/api/server/devices/revoke-all', {}, pc)).status).toBe(200);
    } else {
      const list = JSON.parse((await send(s, '/api/server/devices', { headers: { cookie: pc } })).body) as { devices: { id: string; current: boolean }[] };
      const id = list.devices.find((device) => !device.current)?.id ?? '';
      expect((await post(s, `/api/server/devices/${id}/revoke`, {}, pc)).status).toBe(200);
    }
    await stream.ended;
    expect((await openStream(s, phone)).status).toBe(401);
  });

  it('keeps the streams of the other devices open', async () => {
    const s = server as WebServer;
    const phone = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    const pc = cookieOf(await post(s, '/api/server/sign-in', { secret: SECRET }));
    const stream = await openStream(s, pc);
    let ended = false;
    void stream.ended.then(() => (ended = true));
    await post(s, '/api/server/sign-out', {}, phone);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ended).toBe(false);
  });
});

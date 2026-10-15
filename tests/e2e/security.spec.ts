import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type App } from './fixtures.js';

interface Reply {
  status: number;
  body: string;
}

/** A raw request to the app's server, so any Host, Origin and token can be sent. */
function send(app: App, method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: app.server.port, path: route, method, headers: { host: `127.0.0.1:${app.server.port}`, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const token = (app: App) => ({ 'x-briefstack-token': app.server.token });
const mutating = (app: App) => ({ ...token(app), origin: app.server.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });

test.describe('requests the server must refuse', () => {
  test('a wrong Host header (DNS rebinding) gets nothing, not even the page', async ({ app }) => {
    for (const host of ['evil.example', `evil.example:${app.server.port}`, `127.0.0.1.evil.example:${app.server.port}`]) {
      expect((await send(app, 'GET', '/', { host })).status, host).toBe(403);
      expect((await send(app, 'GET', '/api/projects', { host, ...token(app) })).status, host).toBe(403);
    }
    expect((await send(app, 'GET', '/api/health', token(app))).status).toBe(200);
  });

  test('a missing or wrong token gets no data', async ({ app }) => {
    for (const route of ['/api/projects', '/api/settings', '/api/library/index', '/api/creations', '/api/usage', '/api/paths']) {
      expect((await send(app, 'GET', route)).status, route).toBe(401);
      expect((await send(app, 'GET', route, { 'x-briefstack-token': 'x'.repeat(43) })).status, route).toBe(401);
    }
  });

  test('a write from another origin, or marked cross-site, is refused and changes nothing', async ({ app }) => {
    const idea = JSON.stringify({ idea: 'From somewhere else' });
    for (const headers of [
      { ...mutating(app), origin: 'http://evil.example' },
      { ...mutating(app), origin: 'http://127.0.0.1:1' },
      { ...mutating(app), 'sec-fetch-site': 'cross-site' },
      { ...mutating(app), 'sec-fetch-site': 'same-site' },
      { ...token(app), 'content-type': 'application/json' },
    ]) {
      expect((await send(app, 'POST', '/api/creations', headers, idea)).status, JSON.stringify(headers)).toBe(403);
    }
    expect((await send(app, 'PUT', '/api/settings', { ...mutating(app), origin: 'http://evil.example' }, JSON.stringify({ lang: 'es' }))).status).toBe(403);
    expect((await send(app, 'PUT', '/api/library/note', { ...mutating(app), origin: 'http://evil.example' }, JSON.stringify({ section: 'lessons', text: 'x' }))).status).toBe(403);
    expect(app.manager.list()).toEqual([]);
    expect(JSON.parse((await send(app, 'GET', '/api/settings', token(app))).body)).toMatchObject({ lang: 'en' });
  });

  test('the same write from the app itself goes through', async ({ app }) => {
    const reply = await send(app, 'POST', '/api/creations', mutating(app), JSON.stringify({ idea: 'From the app' }));
    expect(reply.status).toBe(201);
    expect(app.manager.list()).toHaveLength(1);
  });
});

test.describe('a page from another origin', () => {
  let evil: Server;
  let evilOrigin: string;

  test.beforeEach(async () => {
    evil = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>evil</title><p>an unrelated page</p>');
    });
    await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve));
    evilOrigin = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
  });
  test.afterEach(async () => {
    await new Promise<void>((resolve) => evil.close(() => resolve()));
  });

  test('cannot start a creation or read the data, even from the same machine', async ({ page, app }) => {
    await page.goto(`${evilOrigin}/`);
    const outcome = await page.evaluate(
      async ({ target }) => {
        const attempts: Record<string, string> = {};
        // A form-style POST (no preflight), then a JSON one, then a read.
        try {
          const res = await fetch(`${target}/api/creations`, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{"idea":"x"}' });
          attempts.simplePost = `sent (${res.type})`;
        } catch (error) {
          attempts.simplePost = `blocked: ${String(error)}`;
        }
        try {
          await fetch(`${target}/api/creations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"idea":"x"}' });
          attempts.jsonPost = 'sent';
        } catch {
          attempts.jsonPost = 'blocked';
        }
        try {
          const res = await fetch(`${target}/api/settings`);
          attempts.read = `status ${res.status}`;
        } catch {
          attempts.read = 'blocked';
        }
        return attempts;
      },
      { target: app.server.origin },
    );
    expect(outcome.jsonPost).toBe('blocked');
    expect(outcome.read).toBe('blocked');
    // The simple POST may leave the browser, but the server refuses it.
    expect(app.manager.list()).toEqual([]);
  });

  test('cannot put the app in a frame', async ({ page, app }) => {
    await page.goto(`${evilOrigin}/`);
    await page.evaluate((target) => {
      const frame = document.createElement('iframe');
      frame.src = target;
      document.body.append(frame);
    }, app.server.origin);
    await page.waitForTimeout(1500);
    // The browser refuses to show it (frame-ancestors 'none'): the frame holds an error page, not the app.
    const inside = page.frames().filter((frame) => frame !== page.mainFrame());
    expect(inside).toHaveLength(1);
    expect(inside[0]?.url().startsWith(app.server.origin)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('briefstack');
  });
});

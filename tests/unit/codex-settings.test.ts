import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexService, codexUnavailableReason, type CodexStatus, type CodexView } from '../../src/codex/service.js';
import { codexSettingsOf, parseConfig, updateConfig, type PathEnv } from '../../src/config/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { fakeCodex } from '../codexWorld.js';
import { tempDir, writeTree } from '../helpers.js';

// Codex in Settings (decisions.md, "Phase 8: step 25"): off by default,
// `unelevated` by default, 5 calls per round (1 to 10); the status runs only
// on "Check", with the fake Codex here.

describe('the config', () => {
  it('defaults: off, unelevated, 5 calls per round', () => {
    expect(codexSettingsOf({})).toEqual({ enabled: false, mode: 'unelevated', maxCalls: 5 });
  });

  it('reads valid values and refuses the rest', () => {
    expect(parseConfig(JSON.stringify({ codexEnabled: true, codexMode: 'elevated', codexMaxCalls: 10 }), 'c.json')).toEqual({ codexEnabled: true, codexMode: 'elevated', codexMaxCalls: 10 });
    for (const bad of [{ codexEnabled: 'yes' }, { codexMode: 'mxc' }, { codexMaxCalls: 0 }, { codexMaxCalls: 11 }, { codexMaxCalls: 2.5 }]) {
      expect(() => parseConfig(JSON.stringify(bad), 'c.json'), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('availability', () => {
  const passed = (mode?: 'elevated' | 'unelevated', platform = 'win32'): CodexStatus => ({
    v: 1,
    at: '2026-11-08T10:00:00.000Z',
    platform,
    ...(mode === undefined ? {} : { mode }),
    found: true,
    version: { ok: true, text: 'codex-cli 0.167.0' },
    login: { ok: true, text: 'Logged in using ChatGPT' },
    sandbox: { ok: true, text: 'machine\\user' },
    ok: true,
  });

  it('off, never checked, a failed check, a changed mode (Windows only); otherwise available', () => {
    const on = { enabled: true, mode: 'unelevated' as const };
    expect(codexUnavailableReason({ ...on, enabled: false }, passed('unelevated'), 'win32')).toBe('off');
    expect(codexUnavailableReason(on, undefined, 'win32')).toBe('notChecked');
    expect(codexUnavailableReason(on, { ...passed('unelevated'), ok: false }, 'win32')).toBe('checkFailed');
    expect(codexUnavailableReason(on, passed('elevated'), 'win32')).toBe('modeChanged');
    expect(codexUnavailableReason(on, passed('unelevated'), 'win32')).toBeUndefined();
    expect(codexUnavailableReason(on, passed(undefined, 'linux'), 'linux')).toBeUndefined();
    // A check from another system does not count.
    expect(codexUnavailableReason(on, passed(undefined, 'linux'), 'darwin')).toBe('notChecked');
  });
});

describe('the service and its routes', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let log: string;
  let pathEnv: PathEnv;
  let server: WebServer | undefined;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('codex-settings'));
    home = path.join(dir, 'home', '.briefstack');
    log = path.join(dir, 'calls.jsonl');
    await writeFile(log, '', 'utf8');
    // Variables Codex must never get: the check's environment is cleaned too.
    pathEnv = { env: { ...process.env, BRIEFSTACK_HOME: home, CODEX_HOME: dir, OPENAI_API_KEY: 'x', GH_TOKEN: 'y' }, homedir: path.join(dir, 'home'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await cleanup();
  });

  const logged = async (): Promise<{ argv: string[]; cwd: string; suspect: string[] }[]> =>
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; suspect: string[] });

  const service = (platform: NodeJS.Platform, scenario?: string, found = true) => new CodexService({ pathEnv, platform, locate: () => (found ? fakeCodex(log, scenario) : undefined) });

  async function serve(codex: CodexService | undefined): Promise<void> {
    server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: 't'.repeat(43), lang: 'en', pathEnv, ...(codex === undefined ? {} : { codex }) });
  }

  const send = (method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const port = server?.port ?? 0;
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: 't'.repeat(43), origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }));
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  it('GET /api/codex reads the settings and the last check and runs nothing', async () => {
    await serve(service('win32'));
    const reply = await send('GET', '/api/codex');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ enabled: false, mode: 'unelevated', maxCalls: 5, modeOffered: true, available: false, reason: 'off' });
    expect(await logged()).toEqual([]);
  });

  it('PUT /api/settings saves the switch, the mode and the calls per round; out-of-range values are refused', async () => {
    await serve(service('win32'));
    const saved = await send('PUT', '/api/settings', { codexEnabled: true, codexMode: 'elevated', codexMaxCalls: 3 });
    expect(saved.status).toBe(200);
    expect(saved.json.codex).toEqual({ enabled: true, mode: 'elevated', maxCalls: 3 });
    for (const bad of [{ codexMaxCalls: 0 }, { codexMaxCalls: 11 }, { codexMode: 'mxc' }, { codexEnabled: 'yes' }]) expect((await send('PUT', '/api/settings', bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await send('GET', '/api/codex')).json).toMatchObject({ enabled: true, mode: 'elevated', maxCalls: 3, reason: 'notChecked' });
  });

  it('POST /api/codex/check runs the three measured commands, keeps the result, and the tool becomes available', async () => {
    await updateConfig(path.join(home, 'config.json'), { codexEnabled: true });
    await serve(service('win32'));
    const reply = await send('POST', '/api/codex/check');
    expect(reply.status).toBe(200);
    const view = reply.json as unknown as CodexView;
    expect(view).toMatchObject({ available: true, last: { found: true, ok: true, mode: 'unelevated', platform: 'win32', version: { ok: true, text: 'codex-cli 0.167.0' }, login: { ok: true, text: 'Logged in using ChatGPT' }, sandbox: { ok: true, text: 'machine\\sandbox-user' } } });
    const calls = await logged();
    expect(calls.map((call) => call.argv)).toEqual([['--version'], ['login', 'status'], ['sandbox', '-c', 'windows.sandbox="unelevated"', '-P', ':workspace', '--', 'whoami']]);
    // Never our credentials, never CODEX_HOME (so never another auth.json); run in briefstack's own folder.
    expect(calls.flatMap((call) => call.suspect)).toEqual([]);
    // Real paths on both sides: macOS reports its temp folder under /private.
    expect(calls.map((call) => realpathSync(call.cwd))).toEqual(calls.map(() => realpathSync(path.join(home, 'codex', 'check'))));
    // Kept: the next GET runs nothing and shows it.
    expect((await send('GET', '/api/codex')).json).toMatchObject({ available: true, last: { ok: true } });
    expect(await logged()).toHaveLength(3);
  });

  it('a failed login, a failed sandbox or no Codex: the check does not pass and the reason shows', async () => {
    await updateConfig(path.join(home, 'config.json'), { codexEnabled: true });
    expect(await service('win32', 'loggedOut').check()).toMatchObject({ available: false, reason: 'checkFailed', last: { ok: false, login: { ok: false, text: 'Not logged in' } } });
    expect(await service('win32', 'noSandbox').check()).toMatchObject({ available: false, reason: 'checkFailed', last: { ok: false, sandbox: { ok: false } } });
    expect(await service('win32', undefined, false).check()).toMatchObject({ available: false, reason: 'checkFailed', last: { found: false, ok: false } });
  });

  it('a mode changed after the check needs a new one (Windows); elsewhere the mode is not offered nor passed', async () => {
    await updateConfig(path.join(home, 'config.json'), { codexEnabled: true });
    const windows = service('win32');
    await windows.check();
    expect(await windows.session()).toEqual({ command: fakeCodex(log), maxCalls: 5, mode: 'unelevated' });
    await updateConfig(path.join(home, 'config.json'), { codexMode: 'elevated' });
    expect(await windows.view()).toMatchObject({ available: false, reason: 'modeChanged' });
    expect(await windows.session()).toBeUndefined();

    await writeFile(log, '', 'utf8');
    const linux = service('linux');
    const view = await linux.check();
    expect(view).toMatchObject({ modeOffered: false, available: true });
    expect(view.last?.mode).toBeUndefined();
    expect((await logged()).at(-1)?.argv).toEqual(['sandbox', '-P', ':workspace', '--', 'whoami']);
    expect(await linux.session()).toEqual({ command: fakeCodex(log), maxCalls: 5 });
  });

  it('the switch off, or Codex no longer found, gives rounds no tool', async () => {
    const on = service('win32');
    await on.check();
    expect(await on.session()).toBeUndefined();
    await updateConfig(path.join(home, 'config.json'), { codexEnabled: true });
    expect(await on.session()).toBeDefined();
    expect(await service('win32', undefined, false).session()).toBeUndefined();
  });

  it('without a service the routes answer 503', async () => {
    await serve(undefined);
    expect((await send('GET', '/api/codex')).status).toBe(503);
    expect((await send('POST', '/api/codex/check')).status).toBe(503);
  });
});

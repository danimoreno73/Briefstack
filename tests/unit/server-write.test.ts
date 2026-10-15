import { cp, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibrary, libraryHistory, saveNote } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

// Built at run time so the test file holds no secret-looking string.
const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

interface Reply {
  status: number;
  body: string;
}

describe('write API', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer;
  let home: string;
  let libraryDir: string;
  let repoDir: string;
  const logs: string[] = [];

  const send = (method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: urlPath,
          method,
          headers: {
            host: `127.0.0.1:${server.port}`,
            [TOKEN_HEADER]: server.token,
            origin: server.origin,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const ok = async <T>(method: string, urlPath: string, body?: unknown): Promise<T> => {
    const reply = await send(method, urlPath, body);
    expect(reply.status, reply.body).toBe(200);
    return JSON.parse(reply.body) as T;
  };
  const read = (file: string) => readFile(path.join(libraryDir, ...file.split('/')), 'utf8');

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-write'));
    logs.length = 0;
    home = path.join(dir, 'home', '.briefstack');
    libraryDir = path.join(home, 'library');
    repoDir = path.join(dir, 'repo');
    await cp(path.join(PACKAGE_ROOT, '.claude', 'agents'), path.join(repoDir, '.claude', 'agents'), { recursive: true });
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'projects'), sessionsDir: path.join(home, 'sessions'), repoDir });
    await saveNote({ libraryDir, section: 'profile', name: 'style', text: '# Style\n\nShort answers.\n' });
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      log: (line) => logs.push(line),
      pathEnv: {
        env: { BRIEFSTACK_HOME: home },
        homedir: path.join(dir, 'home'),
        pathApi: path,
        caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
      },
      repoDir,
    });
  });
  afterEach(async () => {
    await server.close();
    await cleanup();
  });

  it('requires the token, the origin and JSON on every write route', async () => {
    const routes: [string, string, unknown][] = [
      ['PUT', '/api/library/note', { section: 'lessons', text: 'x' }],
      ['POST', '/api/library/revert', { sha: 'abcd' }],
      ['PUT', '/api/usage', { profile: 'max' }],
      ['PUT', '/api/settings', { lang: 'es' }],
    ];
    for (const [method, route, body] of routes) {
      expect((await send(method, route, body, { [TOKEN_HEADER]: 'wrong' })).status, route).toBe(401);
      expect((await send(method, route, body, { origin: 'http://evil.example' })).status, route).toBe(403);
      expect((await send(method, route, body, { 'sec-fetch-site': 'cross-site' })).status, route).toBe(403);
      expect((await send(method, route, body, { host: 'evil.example' })).status, route).toBe(403);
      expect((await send(method, route, body, { 'content-type': 'text/plain' })).status, route).toBe(415);
      expect((await send(method, route, { ...(body as object), extra: 1 })).status, route).toBe(400);
    }
    expect((await send('GET', '/api/library/revert')).status).toBe(404);
  });

  describe('save note', () => {
    it('rewrites a note and commits it', async () => {
      const saved = await ok<{ mode: string; committed: boolean; file: string }>('PUT', '/api/library/note', {
        section: 'profile',
        name: 'style',
        text: '# Style\n\nLonger answers, with examples.\n',
      });
      expect(saved).toMatchObject({ mode: 'rewrite', committed: true, file: 'profile/style.md' });
      expect(await read('profile/style.md')).toContain('Longer answers');
      expect((await libraryHistory(libraryDir, { limit: 1 }))[0]?.files).toContain('profile/style.md');
    });

    it('turns an addition at the end into a dated append', async () => {
      const existing = await read('profile/style.md');
      const saved = await ok<{ mode: string }>('PUT', '/api/library/note', {
        section: 'profile',
        name: 'style',
        text: `${existing}\nUse plain words.\n`,
      });
      expect(saved.mode).toBe('append');
      expect(await read('profile/style.md')).toMatch(/### \d{4}-\d{2}-\d{2}\n[\s\S]*Use plain words\./);
    });

    it('creates a note, and reports unchanged text without a commit', async () => {
      const note = { section: 'profile', name: 'tone', text: '# Tone\n\nWarm.\n' };
      const created = await ok<{ mode: string }>('PUT', '/api/library/note', note);
      expect(created.mode).toBe('create');
      const again = await ok<{ mode: string; committed: boolean }>('PUT', '/api/library/note', note);
      expect(again).toMatchObject({ mode: 'unchanged', committed: false });
    });

    it('refuses a note with a secret, writes nothing and echoes nothing', async () => {
      const before = await libraryHistory(libraryDir, {});
      const reply = await send('PUT', '/api/library/note', { section: 'profile', name: 'style', text: `# Style\n\nKey: ${FAKE_KEY}\n` });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toMatchObject({ code: 'library.secretContent', params: { file: 'profile/style.md' } });
      expect(reply.body).not.toContain(FAKE_KEY);
      expect(await read('profile/style.md')).not.toContain(FAKE_KEY);
      expect(await libraryHistory(libraryDir, {})).toEqual(before);
      expect(logs.join('\n')).not.toContain(FAKE_KEY);
    });

    it('refuses an unknown section, a bad name and an empty note', async () => {
      expect((await send('PUT', '/api/library/note', { section: 'nope', name: 'x', text: 'x' })).status).toBe(400);
      expect((await send('PUT', '/api/library/note', { section: 'profile', name: '../x', text: 'x' })).status).toBe(400);
      expect((await send('PUT', '/api/library/note', { section: 'profile', name: 'blank', text: '  \n' })).status).toBe(400);
    });
  });

  describe('revert', () => {
    it('reverts a commit with a new commit', async () => {
      const [latest] = await libraryHistory(libraryDir, { limit: 1 });
      const reply = await ok<{ reverted: string; commit: string }>('POST', '/api/library/revert', { sha: latest?.sha });
      expect(reply.reverted).toBe(latest?.sha);
      expect(reply.commit).not.toBe(latest?.sha);
      await expect(read('profile/style.md')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('answers 404 for an unknown commit and 400 for a malformed one', async () => {
      const unknown = await send('POST', '/api/library/revert', { sha: 'deadbeef' });
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toMatchObject({ code: 'library.commitNotFound' });
      expect((await send('POST', '/api/library/revert', { sha: '--abort' })).status).toBe(400);
    });
  });

  describe('usage', () => {
    it('sets the profile through the same code as `usage set`', async () => {
      const set = await ok<{ scope: string; profile: string; sessionModel: string }>('PUT', '/api/usage', { profile: 'max' });
      expect(set).toMatchObject({ scope: 'repo', profile: 'max' });
      const shown = await ok<{ profile: string; fromConfig: boolean }>('GET', '/api/usage');
      expect(shown).toMatchObject({ profile: 'max', fromConfig: true });
    });

    it('refuses an unknown profile', async () => {
      const reply = await send('PUT', '/api/usage', { profile: 'turbo' });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toMatchObject({ code: 'usage.unknownProfile' });
    });
  });

  describe('settings', () => {
    it('changes language and permission policy, and clears the language', async () => {
      const first = await ok<{ lang: string; configLang: string | null; permissionPolicy: string }>('PUT', '/api/settings', {
        lang: 'es',
        permissionPolicy: 'unattended',
      });
      expect(first).toMatchObject({ lang: 'es', configLang: 'es', permissionPolicy: 'unattended' });
      const cleared = await ok<{ configLang: string | null; permissionPolicy: string }>('PUT', '/api/settings', { lang: null });
      expect(cleared).toMatchObject({ configLang: null, permissionPolicy: 'unattended' });
      expect(await ok('GET', '/api/settings')).toMatchObject({ configLang: null, permissionPolicy: 'unattended' });
    });

    it('changes projectsDir, creates it and allows it in the repo settings', async () => {
      const target = path.join(dir, 'elsewhere', 'projects');
      const result = await ok<{ projectsDir: string }>('PUT', '/api/settings', { projectsDir: target });
      expect(result.projectsDir).toBe(target);
      expect(await ok('GET', '/api/settings')).toMatchObject({ projectsDir: target });
      const local = await readFile(path.join(repoDir, '.claude', 'settings.local.json'), 'utf8');
      expect(local).toContain('elsewhere');
    });

    it('refuses a relative projectsDir, bad values and an empty body, changing nothing', async () => {
      const before = await ok('GET', '/api/settings');
      const relative = await send('PUT', '/api/settings', { projectsDir: 'relative/dir' });
      expect(relative.status).toBe(400);
      expect(JSON.parse(relative.body)).toMatchObject({ code: 'config.relativePath' });
      expect((await send('PUT', '/api/settings', { lang: 'fr' })).status).toBe(400);
      expect((await send('PUT', '/api/settings', { permissionPolicy: 'bypass' })).status).toBe(400);
      expect((await send('PUT', '/api/settings', {})).status).toBe(400);
      expect(await ok('GET', '/api/settings')).toEqual(before);
    });
  });

  it('logs method, route and status only', async () => {
    await send('PUT', '/api/library/note', { section: 'profile', name: 'style', text: `Key: ${FAKE_KEY}` });
    expect(logs).toContain('PUT /api/library/note 400');
    expect(logs.join('\n')).not.toContain('Key');
  });
});

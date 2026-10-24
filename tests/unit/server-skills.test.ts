import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibrary } from '../../src/library/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { FakeSkillReviewer } from '../../src/skills/modelReview.js';
import { SkillService } from '../../src/skills/service.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';
import { HARMLESS } from '../skillFixtures.js';
import { sampleRepo, startFakeGitHub, type FakeGitHub } from '../skillsWorld.js';

useHermeticGit();

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('skill routes', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer;
  let gh: FakeGitHub;

  const send = (method: string, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> =>
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
            ...extra,
          },
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

  const start = async (skills: SkillService | undefined) => {
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' },
      ...(skills === undefined ? {} : { skills }),
    });
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-skills'));
    const libraryDir = path.join(dir, 'library');
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'projects'), sessionsDir: path.join(dir, 'sessions'), repoDir: path.join(dir, 'repo') });
    const sample = sampleRepo(Object.fromEntries(Object.entries(HARMLESS).map(([p, v]) => [`skills/tidy/${p}`, v])));
    gh = await startFakeGitHub({ 'acme/skills': sample.repo });
    await start(new SkillService({ libraryDir: async () => libraryDir, fetch: { apiBase: gh.apiBase, rawBase: gh.rawBase }, reviewer: new FakeSkillReviewer() }));
  });
  afterEach(async () => {
    await server.close();
    await gh.close();
    await cleanup();
  });

  it('adds, lists, shows, reads a file, tags, approves, rejects and deletes', async () => {
    const added = await send('POST', '/api/skills', { url: 'https://github.com/acme/skills/tree/main/skills/tidy', tags: ['notes'] });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ committed: true, detail: { record: { name: 'tidy-notes', status: 'quarantine', tags: ['notes'] } } });

    const list = await send('GET', '/api/skills');
    expect((list.json.skills as { name: string; status: string }[]).map((s) => [s.name, s.status])).toEqual([['tidy-notes', 'quarantine']]);
    expect((await send('GET', '/api/skills/tidy-notes')).json).toMatchObject({ record: { name: 'tidy-notes' } });
    const file = await send('GET', `/api/skills/tidy-notes/file?path=${encodeURIComponent('guide.md')}`);
    expect(file.json).toMatchObject({ path: 'guide.md', kind: 'markdown', text: HARMLESS['guide.md'] });
    expect((await send('GET', '/api/skills/tidy-notes/file')).status).toBe(400);

    expect((await send('PUT', '/api/skills/tidy-notes/tags', { tags: ['meetings'] })).json).toMatchObject({ detail: { record: { tags: ['meetings'] } } });
    expect((await send('PUT', '/api/skills/tidy-notes/tags', { tags: ['Bad!'] })).json).toMatchObject({ code: 'skills.invalidTag' });
    expect((await send('POST', '/api/skills/tidy-notes/approve')).json).toMatchObject({ detail: { record: { status: 'approved' } } });
    expect((await send('POST', '/api/skills/tidy-notes/check-update')).json).toMatchObject({ outcome: 'upToDate' });
    expect((await send('POST', '/api/skills/tidy-notes/update/approve')).status).toBe(409);
    expect((await send('POST', '/api/skills/tidy-notes/reject')).json).toMatchObject({ detail: { record: { status: 'rejected' } } });
    expect((await send('POST', '/api/skills/tidy-notes/delete')).json).toMatchObject({ committed: true });
    expect((await send('GET', '/api/skills/tidy-notes')).status).toBe(404);
  });

  it('answers fetch problems with clear codes and statuses', async () => {
    const bad = await send('POST', '/api/skills', { url: 'https://gitlab.com/acme/skills' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ code: 'skills.invalidUrl', params: { reason: 'notGithub' } });
    expect((await send('POST', '/api/skills', { url: 'https://github.com/acme/none' })).status).toBe(404);
    gh.options.rateLimited = true;
    const limited = await send('POST', '/api/skills', { url: 'https://github.com/acme/skills/tree/main/skills/tidy' });
    expect(limited.status).toBe(429);
    expect(String(limited.json.message)).toContain('limit');
    expect((await send('POST', '/api/skills', { url: 'x', extra: 1 })).status).toBe(400);
  });

  it('needs the token and the same origin to change anything', async () => {
    const noToken = await send('POST', '/api/skills', { url: 'https://github.com/acme/skills/tree/main/skills/tidy' }, { [TOKEN_HEADER]: 'nope' });
    expect(noToken.status).toBe(401);
    const otherOrigin = await send('POST', '/api/skills', { url: 'https://github.com/acme/skills/tree/main/skills/tidy' }, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    expect(otherOrigin.status).toBe(403);
    expect(gh.requests).toEqual([]);
  });

  it('answers 503 without a skill service', async () => {
    await server.close();
    await start(undefined);
    expect((await send('GET', '/api/skills')).json).toMatchObject({ code: 'skills.unavailable' });
  });
});

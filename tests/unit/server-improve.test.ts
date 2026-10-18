import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathEnv } from '../../src/config/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { RESEARCHER, makeImproveRepo, openImproveWorld, researcherRound, testGit, type ImproveWorld } from '../improveWorld.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

function send(server: WebServer, urlPath: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path: urlPath, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('improvement API', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer | undefined;
  let world: ImproveWorld | undefined;
  let repo: string;
  let pathEnv: PathEnv;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('server-improve'));
    repo = path.join(dir, 'repo');
    await makeImproveRepo(repo);
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
    pathEnv = { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
  });
  afterEach(async () => {
    await world?.manager.shutdown();
    await server?.close();
    world = undefined;
    server = undefined;
    await cleanup();
  });

  const start = async (withImprove: boolean): Promise<WebServer> => {
    const home = path.join(dir, 'home');
    if (withImprove) {
      world = await openImproveWorld({
        repoDir: repo,
        home,
        pathEnv,
        sessionsDir: path.join(home, 'sessions'),
        libraryDir: path.join(home, 'library'),
        projectsDir: path.join(dir, 'projects'),
        script: { rounds: [researcherRound()] },
      });
    }
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      pathEnv,
      repoDir: repo,
      ...(world === undefined ? {} : { improvements: world.manager }),
    });
    return server;
  };
  const auth = (s: WebServer) => ({ [TOKEN_HEADER]: s.token });
  const mutating = (s: WebServer) => ({ ...auth(s), origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  const post = (s: WebServer, urlPath: string, body?: unknown) =>
    send(s, urlPath, { method: 'POST', headers: mutating(s), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = async (s: WebServer, urlPath: string) => JSON.parse((await send(s, urlPath, { headers: auth(s) })).body) as Record<string, unknown>;

  it('answers 503 improve.unavailable without a manager', async () => {
    const s = await start(false);
    const reply = await send(s, '/api/improve', { headers: auth(s) });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ code: 'improve.unavailable' });
  });

  it('needs the token, and the same origin to change anything', async () => {
    const s = await start(true);
    expect((await send(s, '/api/improve')).status).toBe(401);
    const crossSite = await send(s, '/api/improve/proposals', {
      method: 'POST',
      headers: { ...auth(s), origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'x' }),
    });
    expect(crossSite.status).toBe(403);
    expect(((await get(s, '/api/improve')).proposals as unknown[]).length).toBe(0);
  });

  it('prepares, shows, approves and reverts a proposal', async () => {
    const s = await start(true);
    expect((await post(s, '/api/improve/proposals', { request: '' })).status).toBe(400);
    expect((await post(s, '/api/improve/proposals', { request: 'x', extra: 1 })).status).toBe(400);
    const prepared = await post(s, '/api/improve/proposals', { request: 'Shorter reports.', lessons: true });
    expect(prepared.status).toBe(202);
    const { proposal } = JSON.parse(prepared.body) as { proposal: { id: string } };
    let shown: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i += 1) {
      shown = await get(s, `/api/improve/proposals/${proposal.id}`);
      if ((shown.proposal as { status: string }).status === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(shown.proposal).toMatchObject({ status: 'ready', offeredCheck: 'improvement-flow' });
    expect(JSON.stringify(shown)).not.toContain('worktreeDir');
    expect(shown.check).toMatchObject({ name: 'improvement-flow' });
    const listing = await get(s, '/api/improve');
    expect(listing).toMatchObject({ proposals: [{ id: proposal.id, status: 'ready', files: [RESEARCHER] }], suggestions: [], blockers: [] });

    const approved = await post(s, `/api/improve/proposals/${proposal.id}/approve`);
    expect(approved.status).toBe(200);
    expect(await readFile(path.join(repo, ...RESEARCHER.split('/')), 'utf8')).toContain('under one page');
    expect((await testGit(repo, ['log', '-1', '--format=%s'])).trim()).toBe(`Apply improvement ${proposal.id}: Shorter research reports`);
    expect(JSON.parse((await post(s, `/api/improve/proposals/${proposal.id}/approve`)).body)).toMatchObject({ code: 'improve.wrongState' });
    expect((await post(s, `/api/improve/proposals/${proposal.id}/revert`)).status).toBe(200);
    expect((await testGit(repo, ['log', '-1', '--format=%s'])).trim()).toBe(`Revert improvement ${proposal.id}: Shorter research reports`);
  });

  it('answers 404 for an unknown proposal and 409 while a session runs', async () => {
    const s = await start(true);
    expect((await send(s, '/api/improve/proposals/imp-zzzzzz-0000', { headers: auth(s) })).status).toBe(404);
    (world as ImproveWorld).runner.script = { rounds: [{ hold: true }] };
    expect((await post(s, '/api/improve/proposals', { request: 'one' })).status).toBe(202);
    const busy = await post(s, '/api/improve/proposals', { request: 'two' });
    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body)).toMatchObject({ code: 'improve.busy' });
  });
});

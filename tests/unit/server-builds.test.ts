import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildManager } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import type { PlanOutput } from '../../src/builds/types.js';
import type { PathEnv } from '../../src/config/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { UsageCheck } from '../../src/usage/warning.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// The build routes (docs/api.md, "Builds").

useHermeticGit();

const TOKEN = 't'.repeat(43);
const PLAN: PlanOutput = { tasks: [{ title: 'A', instruction: 'Write A.md.', doneWhen: 'A.md exists.', dependsOn: [] }], commands: ['npm test'], checks: [] };

let world: TaskWorld;
let server: WebServer | undefined;
let tasks: TaskManager;
let builds: BuildManager;

function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = server?.port ?? 0;
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: TOKEN, origin: `http://127.0.0.1:${port}`, ...(text === undefined ? {} : { 'content-type': 'application/json' }) } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (out += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out === '' ? {} : (JSON.parse(out) as Record<string, unknown>) }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function serve(usage?: UsageCheck, withBuilds = true): Promise<void> {
  await writeTree(path.join(world.dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
  const pathEnv: PathEnv = { env: { BRIEFSTACK_HOME: world.home, BRIEFSTACK_LIBRARY: world.library }, homedir: path.join(world.dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
  server = await startWebServer({ port: 0, uiDir: path.join(world.dir, 'ui'), token: TOKEN, lang: 'en', pathEnv, repoDir: world.repo, tasks, ...(withBuilds ? { builds } : {}), ...(usage === undefined ? {} : { usageCheck: usage }) });
}

beforeEach(async () => {
  world = await taskWorld('server-builds');
  await world.project('garden', { 'docs/BRIEF.md': '# Garden\n' });
  await world.project('orchard');
  const holder: { builds?: BuildManager } = {};
  tasks = new TaskManager({
    runner: new TaskFakeRunner(),
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 2,
    pollMs: 10,
    afterRound: afterRoundWith(),
    buildOn: (slug) => holder.builds?.holder(slug),
  });
  builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner: new FakeBuildPlanner(PLAN),
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => 2,
  });
  holder.builds = builds;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await builds.shutdown();
  await tasks.shutdown();
  await world.cleanup();
});

describe('build routes', () => {
  it('answer 503 without a build manager', async () => {
    await serve(undefined, false);
    expect(await call('GET', '/api/builds/mabc12-0a0b')).toMatchObject({ status: 503, json: { code: 'build.unavailable' } });
  });

  it('say whether a project can be planned, plan it, show it, and start it only with the confirmation and valid rules', async () => {
    await serve();
    expect((await call('GET', '/api/projects/garden/builds')).json).toMatchObject({ builds: [], plan: { ok: true }, thresholds: { fiveHour: 80, week: 90 } });
    expect((await call('GET', '/api/projects/orchard/builds')).json).toMatchObject({ plan: { ok: false, code: 'build.noBrief' } });
    const planned = await call('POST', '/api/projects/garden/builds', {});
    expect(planned.status).toBe(201);
    const id = planned.json.id as string;
    await builds.idle(id);
    expect((await call('GET', `/api/builds/${id}`)).json).toMatchObject({ id, state: 'planned', plan: PLAN });
    expect((await call('GET', '/api/projects/garden/builds')).json).toMatchObject({ builds: [{ id }], plan: { ok: false, code: 'build.projectBusy' } });

    const body = { tasks: PLAN.tasks, limit: 1, commands: ['npm test'], checks: [], fixRounds: 1, thresholds: { fiveHour: 80, week: 90 } };
    expect((await call('POST', `/api/builds/${id}/start`, body)).status).toBe(400);
    expect(await call('POST', `/api/builds/${id}/start`, { ...body, commands: ['npm test; rm -rf .'], confirm: true })).toMatchObject({ status: 400, json: { code: 'build.invalidStart' } });
    const started = await call('POST', `/api/builds/${id}/start`, { ...body, confirm: true });
    expect(started).toMatchObject({ status: 200, json: { state: 'running', settings: { limit: 1, commands: ['npm test'] } } });
    await builds.idle(id);
    expect((await call('GET', `/api/builds/${id}`)).json).toMatchObject({ state: 'finished', tasks: [{ state: 'applied' }] });
    expect(await call('GET', '/api/builds/nope')).toMatchObject({ status: 404, json: { code: 'build.notFound' } });
    // A started build is not discarded by this route yet (only one that never started).
    expect(await call('POST', `/api/builds/${id}/discard`, {})).toMatchObject({ status: 409, json: { code: 'build.wrongState' } });
  });

  it('discard a build that never started, which frees the project (review of M3, I4)', async () => {
    await serve();
    const id = (await call('POST', '/api/projects/garden/builds', {})).json.id as string;
    await builds.idle(id);
    expect(await call('POST', `/api/builds/${id}/discard`, {})).toMatchObject({ status: 200, json: { state: 'discarded' } });
    expect((await call('GET', '/api/projects/garden/builds')).json).toMatchObject({ plan: { ok: true } });
  });

  it('warn about high plan usage before planning, unless forced', async () => {
    await serve(new UsageCheck({ read: async () => ({ fiveHour: 95, sevenDay: 10 }), thresholds: async () => ({ fiveHour: 80, week: 90 }), ttlMs: 0 }));
    expect(await call('POST', '/api/projects/garden/builds', {})).toMatchObject({ status: 409, json: { code: 'usage.high' } });
    expect((await call('POST', '/api/projects/garden/builds', { force: true })).status).toBe(201);
  });
});

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChatTool, parseArgs, type ActionTool } from '../../src/chat/tools.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager } from '../../src/creation/manager.js';
import { parseConfig, usageWarningOf } from '../../src/config/index.js';
import { isBriefstackError } from '../../src/errors.js';
import { computeSuggestions, SuggestionStore, type Suggestion } from '../../src/improve/suggestions.js';
import { addNote, initLibrary, listProjects, setProjectArchived } from '../../src/library/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { UsageCheck } from '../../src/usage/warning.js';
import { chatWorld, type ChatWorld } from '../chatWorld.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';
import { makeImproveRepo, openImproveWorld, researcherRound, type ImproveWorld } from '../improveWorld.js';

useHermeticGit();

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('UsageCheck', () => {
  const thresholds = async () => ({ fiveHour: 80, week: 85 });

  it('warns at or above a threshold, with the values, and not below', async () => {
    let reading = { fiveHour: 79, sevenDay: 84 };
    let now = 0;
    const check = new UsageCheck({ read: async () => reading, thresholds, ttlMs: 1000, now: () => now });
    expect(await check.check()).toBeUndefined();
    reading = { fiveHour: 80, sevenDay: 10 };
    now = 2000;
    expect(await check.check()).toEqual({ fiveHour: 80, sevenDay: 10, warnFiveHour: 80, warnWeek: 85 });
    reading = { fiveHour: 5, sevenDay: 90 };
    now = 4000;
    expect(await check.check()).toMatchObject({ sevenDay: 90 });
  });

  it('reuses a recent reading and never warns without one', async () => {
    let reads = 0;
    let now = 0;
    const check = new UsageCheck({ read: async () => ((reads += 1), { fiveHour: 95, sevenDay: 1 }), thresholds, ttlMs: 60_000, now: () => now });
    await Promise.all([check.check(), check.check()]);
    now = 30_000;
    await check.check();
    expect(reads).toBe(1);
    now = 90_000;
    await check.check();
    expect(reads).toBe(2);
    expect(await new UsageCheck({ read: async () => undefined, thresholds }).check()).toBeUndefined();
    expect(await new UsageCheck({ read: () => Promise.reject(new Error('no')), thresholds }).check()).toBeUndefined();
  });

  it('takes its thresholds from the config, 1 to 100, defaults 80 and 85', () => {
    expect(usageWarningOf({})).toEqual({ fiveHour: 80, week: 85 });
    expect(usageWarningOf(parseConfig('{"usageWarnFiveHour": 50, "usageWarnWeek": 99}', 'c'))).toEqual({ fiveHour: 50, week: 99 });
    expect(() => parseConfig('{"usageWarnWeek": 101}', 'c')).toThrow();
    expect(() => parseConfig('{"usageWarnFiveHour": 0}', 'c')).toThrow();
  });
});

describe('small additions over HTTP', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer;
  let manager: CreationManager;
  let reading: { fiveHour: number | null; sevenDay: number | null };
  let libraryDir: string;
  let home: string;

  const send = (method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: urlPath,
          method,
          headers: { host: `127.0.0.1:${server.port}`, [TOKEN_HEADER]: server.token, origin: server.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
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

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('small-additions'));
    home = path.join(dir, 'home');
    libraryDir = path.join(home, 'library');
    const projectsDir = path.join(dir, 'projects');
    await initLibrary({ libraryDir, projectsDir, sessionsDir: path.join(home, 'sessions'), repoDir: path.join(dir, 'repo') });
    await addNote({
      libraryDir,
      section: 'projects',
      name: 'garden',
      text: `---\ntarget: claude-code\npath: ${path.join(projectsDir, 'garden').replaceAll('\\', '/')}\nstatus: created\nprofile: balanced\nsummary: A garden planner.\n---\n# Garden planner\n`,
    });
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
    reading = { fiveHour: 90, sevenDay: 20 };
    manager = new CreationManager({
      runner: new FakeRunner({ steps: parseRecording('{"do":"session","phase":"started"}\n{"do":"session","phase":"finished","outcome":"completed"}') }),
      sessionsDir: path.join(home, 'sessions'),
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
    });
    const pathEnv = { env: { BRIEFSTACK_HOME: home }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      pathEnv,
      creations: manager,
      usageCheck: new UsageCheck({ read: async () => reading, thresholds: async () => ({ fiveHour: 80, week: 85 }), ttlMs: 0 }),
    });
  });
  afterEach(async () => {
    await manager.shutdown();
    await server.close();
    await cleanup();
  });

  it('a start with high plan usage asks for "start anyway"; with it, or with low usage, it starts', async () => {
    const warned = await send('POST', '/api/creations', { idea: 'A garden planner' });
    expect(warned.status).toBe(409);
    expect(warned.json).toMatchObject({ code: 'usage.high', params: { fiveHour: 90, sevenDay: 20, warnFiveHour: 80, warnWeek: 85 } });
    expect(manager.list()).toEqual([]);
    expect((await send('POST', '/api/creations', { idea: 'A garden planner', force: true })).status).toBe(201);
    reading = { fiveHour: 10, sevenDay: 10 };
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await send('POST', '/api/creations', { idea: 'Another' })).status).toBe(201);
  });

  it('settings take and show the thresholds', async () => {
    expect((await send('GET', '/api/settings')).json).toMatchObject({ usageWarning: { fiveHour: 80, week: 85 } });
    const saved = await send('PUT', '/api/settings', { usageWarnFiveHour: 60, usageWarnWeek: 95 });
    expect(saved.json).toMatchObject({ usageWarning: { fiveHour: 60, week: 95 } });
    expect((await send('PUT', '/api/settings', { usageWarnWeek: 0 })).status).toBe(400);
  });

  it('archives and unarchives a project in its note, one commit each, nothing deleted', async () => {
    const archived = await send('PUT', '/api/projects/garden/archived', { archived: true });
    expect(archived.json).toMatchObject({ archived: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), committed: true });
    expect(git(libraryDir, ['log', '-1', '--format=%s']).trim()).toBe('library: archive projects/garden');
    expect((await listProjects(libraryDir))[0]?.status?.archived).toMatch(/^\d{4}-/);
    const listed = await send('GET', '/api/projects');
    expect(JSON.stringify(listed.json)).toContain('"archived"');
    expect((await send('PUT', '/api/projects/garden/archived', { archived: true })).json).toMatchObject({ committed: false });
    expect((await send('PUT', '/api/projects/garden/archived', { archived: false })).json).toEqual({ archived: null, committed: true, warnings: [] });
    const note = await readFile(path.join(libraryDir, 'projects', 'garden.md'), 'utf8');
    expect(note).not.toContain('archived');
    expect(note).toContain('# Garden planner');
    expect((await send('PUT', '/api/projects/nope/archived', { archived: true })).status).toBe(404);
  });
});

describe('setProjectArchived', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('archive'));
  });
  afterEach(() => cleanup());

  it('keeps the rest of the note byte for byte and survives a later library add', async () => {
    const libraryDir = path.join(dir, 'library');
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'p'), sessionsDir: path.join(dir, 's'), repoDir: path.join(dir, 'r') });
    await addNote({ libraryDir, section: 'projects', name: 'x', text: '---\ntarget: claude-app\npath: /p/x\nstatus: created\nprofile: saver\nsummary: X.\n---\n# X\n\nBody.\n' });
    const file = path.join(libraryDir, 'projects', 'x.md');
    const before = await readFile(file, 'utf8');
    await setProjectArchived({ libraryDir, slug: 'x', archived: true, now: new Date('2026-10-24T10:00:00Z') });
    const after = await readFile(file, 'utf8');
    expect(after).toBe(before.replace('summary: X.\n', 'summary: X.\narchived: 2026-10-24\n'));
    await addNote({ libraryDir, section: 'projects', name: 'x', text: 'More.\n' });
    expect((await listProjects(libraryDir))[0]?.status?.archived).toBe('2026-10-24');
    await setProjectArchived({ libraryDir, slug: 'x', archived: false });
    expect((await readFile(file, 'utf8')).includes('archived')).toBe(false);
    await writeFile(file, '---\nbroken: [\n---\n', 'utf8');
    await expect(setProjectArchived({ libraryDir, slug: 'x', archived: true })).rejects.toSatisfy(isBriefstackError);
  });
});

describe('discarded suggestions and the usage note on chat cards', { timeout: 60_000 }, () => {
  let world: ChatWorld;
  let improve: ImproveWorld;
  let suggestions: Suggestion[];

  beforeEach(async () => {
    world = await chatWorld();
    const repo = path.join(world.dir, 'improve-repo');
    await makeImproveRepo(repo);
    const store = new SuggestionStore(path.join(world.home, 'improve', 'suggestions.json'));
    suggestions = computeSuggestions({ state: { id: 'c1', idea: 'A meal planner', sessionId: 's1', textTurns: 1, outcome: 'failed' }, lessons: [] }, new Date('2026-10-18T10:00:00Z'));
    await store.add(suggestions);
    improve = await openImproveWorld({ repoDir: repo, home: world.home, pathEnv: world.pathEnv, sessionsDir: world.sessionsDir, libraryDir: world.libraryDir, projectsDir: world.projectsDir, script: { rounds: [researcherRound()] }, suggestions: store });
    world.tools.improvements = () => improve.manager;
  }, 60_000);
  afterEach(async () => {
    await improve.manager.shutdown();
    await world.creations.shutdown();
    await world.cleanup();
  });

  it('a discarded suggestion is never listed again, also after a reopen, and cannot be prepared', async () => {
    const [first, second] = suggestions as [Suggestion, Suggestion];
    await improve.manager.discardSuggestion(first.id);
    expect((await improve.manager.suggestions()).map((s) => s.id)).toEqual([second.id]);
    const reopened = new SuggestionStore(path.join(world.home, 'improve', 'suggestions.json'));
    expect((await reopened.get(first.id))?.dismissedAt).toBeDefined();
    await expect(improve.manager.discardSuggestion(first.id)).rejects.toMatchObject({ code: 'improve.suggestionNotFound' });
    const tool = findChatTool('prepare_improvement') as ActionTool;
    await expect(tool.propose(world.tools, parseArgs(tool, { request: 'x', suggestionId: first.id }) as never)).rejects.toThrow(/no suggestion/);
    await expect(improve.manager.prepare('x', { suggestionId: first.id })).rejects.toMatchObject({ code: 'improve.suggestionNotFound' });
  });

  it('start and improvement cards carry high plan usage, and nothing when it is low', async () => {
    let high = true;
    world.tools.usageCheck = new UsageCheck({ read: async () => (high ? { fiveHour: 81, sevenDay: 30 } : { fiveHour: 1, sevenDay: 1 }), thresholds: async () => ({ fiveHour: 80, week: 85 }), ttlMs: 0 });
    const start = findChatTool('start_creation') as ActionTool;
    const card = (await start.propose(world.tools, parseArgs(start, { idea: 'A garden planner' }) as never)).card;
    expect(card).toMatchObject({ kind: 'startCreation', usage: { fiveHour: 81, warnFiveHour: 80 } });
    const prepare = findChatTool('prepare_improvement') as ActionTool;
    expect((await prepare.propose(world.tools, parseArgs(prepare, { request: 'Shorter questions.' }) as never)).card).toMatchObject({ usage: { fiveHour: 81 } });
    high = false;
    expect((await start.propose(world.tools, parseArgs(start, { idea: 'A garden planner' }) as never)).card).not.toHaveProperty('usage');
  });
});

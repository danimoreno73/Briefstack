import { request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS, type ChatToolName } from '../../src/chat/toolNames.js';
import { findChatTool, parseArgs, type ActionTool, type ReadTool } from '../../src/chat/tools.js';
import type { PathEnv } from '../../src/config/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { taskRoutes } from '../../src/server/tasks.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import * as checksModule from '../../src/tasks/checks.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { SESSION, chatWorld } from '../chatWorld.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// The declared checks run project code the session changed, so they run on
// one path only: the user's request on the proposal page (decisions.md, S8).
// Nothing else may run them: not the round's end, a new round, approving,
// discarding, reverting, a server start, any other route, or the chat. These
// tests call each of those with a spy in place of the checks (M1 of the
// step-5 review: behaviour, not the code's text).

useHermeticGit();

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

let world: TaskWorld;

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** Checks that only count their calls: `commands` is what the page reads, `run` is what would run them. */
function spyChecks(): { checks: TaskChecks; runs: string[][] } {
  const runs: string[][] = [];
  return { runs, checks: { commands: async () => ['npm test'], run: async (_dir, commands) => (runs.push([...commands]), []) } };
}

function openManager(checks: TaskChecks): TaskManager {
  return new TaskManager({
    runner: new TaskFakeRunner(),
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 2,
    pollMs: 10,
    afterRound: afterRoundWith(),
    checks,
  });
}

/** Ends the round once the session's turn is over, and waits for the proposal. */
async function endRound(m: TaskManager, id: string): Promise<void> {
  await until(async () => (await m.get(id)).awaitingReply !== undefined, 'the turn to end');
  m.finishRound(id);
  await until(async () => (await m.get(id)).state === 'proposal', 'the proposal');
}

beforeEach(async () => {
  world = await taskWorld('tasks-checks-invariant');
});
afterEach(() => world.cleanup());

describe('only the user\'s request runs the declared checks', { timeout: 60_000 }, () => {
  it('no other action of a task runs them, through the whole life of three tasks', async () => {
    const { checks, runs } = spyChecks();
    const m = openManager(checks);
    await world.project('garden');

    // Start, the round's end, reading it (what the page and the chat read), a new round, approve, revert.
    const first = await m.start('garden', 'Add a changelog.');
    await endRound(m, first.id);
    await m.get(first.id);
    await m.list();
    expect((await m.proposal(first.id)).checkCommands).toEqual(['npm test']);
    await m.newRound(first.id, 'More.');
    await endRound(m, first.id);
    await m.approve(first.id);
    await m.revert(first.id);

    // Another task: discarded; a third one cut short by a server stop and recovered.
    const second = await m.start('garden', 'Something else.');
    await endRound(m, second.id);
    await m.discard(second.id);
    const third = await m.start('garden', 'A third.');
    await endRound(m, third.id);
    await m.shutdown();
    const fresh = openManager(checks);
    await fresh.recover();
    expect(runs).toEqual([]);

    // The one path that does.
    await fresh.runChecks(third.id, ['npm test']);
    await until(async () => (await fresh.get(third.id)).state === 'proposal', 'the checks');
    expect(runs).toEqual([['npm test']]);
    await fresh.shutdown();
  });
});

describe('no chat tool runs them', { timeout: 60_000 }, () => {
  it('calls every read tool, and proposes and performs every action, on a task waiting with checks: none runs', async () => {
    const chat = await chatWorld();
    const { checks, runs } = spyChecks();
    const m = openManager(checks);
    try {
      chat.tools.tasks = () => m;
      await world.project('garden');
      await world.project('orchard');
      const task = await m.start('garden', 'Add a changelog.');
      await endRound(m, task.id);

      // Arguments that reach each tool's work; a refusal is fine, the spy is what counts.
      const args: Record<ChatToolName, Record<string, unknown>> = {
        list_projects: {},
        show_project: { slug: 'garden' },
        search_library: { query: 'garden' },
        read_note: { section: 'index' },
        list_sessions: {},
        session_panel: { sessionId: SESSION },
        show_usage: {},
        show_settings: {},
        list_suggestions: {},
        list_proposals: {},
        show_proposal: { proposalId: task.id },
        list_skills: {},
        list_tasks: {},
        show_task: { taskId: task.id },
        start_creation: { idea: 'A recipe box.' },
        cancel_creation: { creationId: task.id },
        start_task: { project: 'orchard', description: 'Run the tests.' },
        propose_note_change: { section: 'lessons', text: 'Run the checks.\n' },
        set_usage_profile: { profile: 'saver' },
        prepare_improvement: { request: 'Run the checks after each round.' },
        add_skill: { url: 'https://github.com/example/skills' },
        add_skill_to_project: { skill: 'checks', project: 'garden' },
      };
      // A new tool must be added here.
      expect(Object.keys(args).sort()).toEqual([...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS].sort());

      const reached: string[] = [];
      for (const name of CHAT_READ_TOOLS) {
        const definition = findChatTool(name) as ReadTool;
        try {
          await definition.run(chat.tools, parseArgs(definition, args[name]) as never);
          reached.push(name);
        } catch {
          // Refused: nothing ran.
        }
      }
      for (const name of CHAT_ACTION_TOOLS) {
        const definition = findChatTool(name) as ActionTool;
        try {
          const proposal = await definition.propose(chat.tools, parseArgs(definition, args[name]) as never);
          await proposal.perform();
          reached.push(name);
        } catch {
          // Refused before or at the card: nothing ran.
        }
      }
      // The task tools did their work on the waiting task.
      expect(reached).toEqual(expect.arrayContaining(['list_tasks', 'show_task', 'start_task']));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs).toEqual([]);
      expect((await m.get(task.id)).state).toBe('proposal');
    } finally {
      await m.shutdown();
      await chat.cleanup();
    }
  });
});

describe('no task route but the proposal page\'s runs them', { timeout: 60_000 }, () => {
  const TOKEN = 't'.repeat(43);
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** A request to the server; a stream is closed once it answered. */
  function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const port = server?.port ?? 0;
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: TOKEN, origin: `http://127.0.0.1:${port}`, ...(text === undefined ? {} : { 'content-type': 'application/json' }) },
        },
        (res) => {
          if (String(res.headers['content-type']).startsWith('text/event-stream')) {
            resolve({ status: res.statusCode ?? 0, json: {} });
            req.destroy();
            return;
          }
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (out += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out === '' ? {} : (JSON.parse(out) as Record<string, unknown>) }));
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
      req.end(text);
    });
  }

  it('calls every other task route on a task waiting with checks, through a new round, approve and revert: none runs', async () => {
    const { checks, runs } = spyChecks();
    const m = openManager(checks);
    try {
      await world.project('garden');
      await world.initLibrary();
      await writeTree(path.join(world.dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
      const pathEnv: PathEnv = { env: { BRIEFSTACK_HOME: world.home, BRIEFSTACK_LIBRARY: world.library }, homedir: path.join(world.dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
      server = await startWebServer({ port: 0, uiDir: path.join(world.dir, 'ui'), token: TOKEN, lang: 'en', pathEnv, repoDir: world.repo, tasks: m });
      const task = await m.start('garden', 'Add a changelog.');
      await endRound(m, task.id);
      const id = task.id;

      const covered = new Set<string>();
      const hit = async (route: string, urlPath: string, body?: unknown) => {
        covered.add(route);
        return call(route.split(' ')[0] ?? 'GET', urlPath, body);
      };
      await hit('GET /api/tasks', '/api/tasks');
      await hit('GET /api/tasks/:id', `/api/tasks/${id}`);
      await hit('GET /api/tasks/:id/stream', `/api/tasks/${id}/stream`);
      await hit('POST /api/tasks/:id/answer', `/api/tasks/${id}/answer`, { pendingId: 'p1', answer: 'once' });
      await hit('POST /api/tasks/:id/reply', `/api/tasks/${id}/reply`, { text: 'Run the checks.' });
      await hit('POST /api/tasks/:id/cancel', `/api/tasks/${id}/cancel`);
      await hit('GET /api/tasks/:id/proposal', `/api/tasks/${id}/proposal`);
      await hit('GET /api/projects/:slug/tasks', '/api/projects/garden/tasks');
      await hit('PUT /api/projects/:slug/checks', '/api/projects/garden/checks', { commands: ['npm test'], confirm: true });
      await hit('POST /api/projects/:slug/git-init', '/api/projects/garden/git-init', { confirm: true });
      await hit('POST /api/tasks', '/api/tasks', { project: 'garden', description: 'Run the checks.' });
      expect((await hit('POST /api/tasks/:id/changes', `/api/tasks/${id}/changes`, { text: 'More.' })).status).toBe(200);
      await until(async () => (await m.get(id)).awaitingReply !== undefined, 'the turn to end');
      expect((await hit('POST /api/tasks/:id/finish', `/api/tasks/${id}/finish`)).status).toBe(200);
      await until(async () => (await m.get(id)).state === 'proposal', 'the proposal');
      expect((await hit('POST /api/tasks/:id/approve', `/api/tasks/${id}/approve`, { confirm: true })).json).toMatchObject({ state: 'applied' });
      expect((await hit('POST /api/tasks/:id/revert', `/api/tasks/${id}/revert`, { confirm: true })).json).toMatchObject({ state: 'reverted' });
      await hit('POST /api/tasks/:id/discard', `/api/tasks/${id}/discard`, { confirm: true });

      // Every task route but the one: a new route must be added here.
      const all = taskRoutes(undefined, { pathEnv, paths: async () => ({ libraryDir: world.library, home: world.home, repoDir: world.repo }) }).map(([route]) => route);
      expect([...covered].sort()).toEqual(all.filter((route) => route !== 'POST /api/tasks/:id/checks').sort());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs).toEqual([]);

      // The one that does, on a new task's proposal.
      const next = (await call('POST', '/api/tasks', { project: 'garden', description: 'Another.' })).json.id as string;
      await endRound(m, next);
      expect((await call('POST', `/api/tasks/${next}/checks`, { commands: ['npm test'], confirm: true })).status).toBe(202);
      await until(async () => (await m.get(next)).state === 'proposal', 'the checks');
      expect(runs).toEqual([['npm test']]);
    } finally {
      await m.shutdown();
    }
  });
});

describe('what can run a check', () => {
  it('checks.ts exports nothing that runs a command but taskChecksWith', () => {
    // Runtime exports only (types vanish). `runChecks`, which spawns, is not one of them.
    expect(Object.keys(checksModule).sort()).toEqual(
      ['MAX_CHECKS', 'MAX_CHECK_LENGTH', 'checkCommandProblem', 'checkEnv', 'cleanOutput', 'projectChecks', 'readChecks', 'setProjectChecks', 'taskChecksWith', 'writeChecks'].sort(),
    );
  });

  it('in src, only the server\'s wiring takes taskChecksWith; the routes take the note\'s functions, the manager its type', async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => file.split(path.sep).join('/'));
    const importers: Record<string, string[]> = {};
    for (const file of files) {
      if (file === 'tasks/checks.ts') continue;
      const text = await readFile(path.join(SRC, file), 'utf8');
      // Static imports and re-exports, on one line or several, aliases included.
      for (const found of text.matchAll(/(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\*|\w+)\s+from\s+'([^']+)'/g)) {
        const target = found[3] ?? '';
        if (!target.endsWith('/checks.js') || path.posix.normalize(path.posix.join(path.posix.dirname(file), target)) !== 'tasks/checks.js') continue;
        const names = (found[2] ?? '').startsWith('{')
          ? (found[2] ?? '')
              .slice(1, -1)
              .split(',')
              .map((name) => name.trim())
              .filter((name) => name !== '')
          : [found[2] ?? ''];
        importers[file] = [...(importers[file] ?? []), ...names.map((name) => `${found[1] === undefined ? '' : 'type '}${name}`)];
      }
      // Nothing loads it another way.
      expect(text, file).not.toMatch(/(?:import|require)\(\s*['"][^'"]*checks\.js['"]\s*\)/);
    }
    expect(importers).toEqual({
      'server/tasks.ts': ['MAX_CHECK_LENGTH', 'MAX_CHECKS', 'projectChecks', 'setProjectChecks'],
      'tasks/manager.ts': ['type TaskChecks'],
      'tasks/wiring.ts': ['taskChecksWith'],
    });
  });
});

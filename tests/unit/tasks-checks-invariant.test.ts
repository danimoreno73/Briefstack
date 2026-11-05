import { request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS, type ChatToolName } from '../../src/chat/toolNames.js';
import { findChatTool, parseArgs, type ActionTool, type ReadTool } from '../../src/chat/tools.js';
import type { PathEnv } from '../../src/config/index.js';
import type { ImprovementManager } from '../../src/improve/manager.js';
import type { ProposalView } from '../../src/improve/proposal.js';
import type { Suggestion } from '../../src/improve/suggestions.js';
import { addNote } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { scaffold } from '../../src/scaffold/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { taskRoutes } from '../../src/server/tasks.js';
import { FakeSkillReviewer } from '../../src/skills/modelReview.js';
import { SkillService } from '../../src/skills/service.js';
import { parseSpec } from '../../src/spec/index.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import * as checksModule from '../../src/tasks/checks.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { SESSION, chatWorld } from '../chatWorld.js';
import { baseProfiles, specInput, useHermeticGit, writeTree } from '../helpers.js';
import { HARMLESS } from '../skillFixtures.js';
import { sampleRepo, startFakeGitHub } from '../skillsWorld.js';
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

const AT = '2026-10-15T10:00:00.000Z';

/** Improvements that only note what the chat asked of them: one suggestion and one ready proposal. */
function fakeImprovements(calls: string[]): ImprovementManager {
  const view: ProposalView = { id: 'improve-1', createdAt: AT, updatedAt: AT, status: 'ready', request: 'Shorter reports.', evidence: [], baseBranch: 'main', baseCommit: 'a'.repeat(40), branch: 'improve/improve-1', rounds: [], files: [] };
  const suggestion: Suggestion = { id: 'suggestion-1', kind: 'lessons', creationId: 'creation-1', idea: 'A recipe box.', createdAt: AT, target: '.claude/agents/interviewer.md', params: { count: 1 } };
  const fake: Pick<ImprovementManager, 'activeId' | 'list' | 'get' | 'suggestions' | 'blockers' | 'sessionProfile' | 'prepare'> = {
    activeId: () => undefined,
    list: async () => (calls.push('list'), [{ id: view.id, status: view.status, request: view.request, createdAt: AT, updatedAt: AT, files: [] }]),
    get: async (id) => (calls.push(`get ${id}`), view),
    suggestions: async () => (calls.push('suggestions'), [suggestion]),
    blockers: async () => [],
    sessionProfile: async () => ({ model: 'sonnet' }),
    prepare: async (request) => (calls.push(`prepare ${request}`), view),
  };
  return fake as unknown as ImprovementManager;
}

describe('no chat tool runs them', { timeout: 60_000 }, () => {
  it('calls every read tool, and proposes and performs every action, each reaching its work, on a task waiting with checks: none runs', async () => {
    const chat = await chatWorld();
    const { checks, runs } = spyChecks();
    const m = openManager(checks);
    // Two skills on a fake GitHub: one approved in the library before, one the chat adds.
    const repo = Object.fromEntries(
      Object.entries(HARMLESS).flatMap(([file, value]) => [
        [`skills/tidy/${file}`, value as string],
        [`skills/other/${file}`, file === 'SKILL.md' ? (value as string).replace('name: tidy-notes', 'name: other-notes') : (value as string)],
      ]),
    );
    const gh = await startFakeGitHub({ 'acme/skills': sampleRepo(repo).repo });
    try {
      chat.tools.tasks = () => m;
      const improvementCalls: string[] = [];
      chat.tools.improvements = () => fakeImprovements(improvementCalls);
      const skills = new SkillService({ libraryDir: async () => chat.libraryDir, fetch: { apiBase: gh.apiBase, rawBase: gh.rawBase }, reviewer: new FakeSkillReviewer() });
      chat.tools.skills = skills;
      await skills.add('https://github.com/acme/skills/tree/main/skills/tidy');
      await skills.approve('tidy-notes');
      // A project briefstack made, for the skill to go into.
      const notesDir = path.join(chat.projectsDir, 'notes');
      await scaffold(parseSpec(specInput({ slug: 'notes' }), 'spec.json'), notesDir, {
        protectedDirs: [],
        templateRoots: [path.join(PACKAGE_ROOT, 'library', 'templates')],
        profiles: await baseProfiles(),
        gitInit: false,
      });
      await addNote({
        libraryDir: chat.libraryDir,
        section: 'projects',
        name: 'notes',
        text: `---\ntarget: claude-code\npath: ${notesDir.replaceAll('\\', '/')}\nstatus: created\nprofile: balanced\nsummary: Meeting notes.\n---\n# Notes\n`,
      });
      const creation = await chat.creations.create('A garden planner.');
      await world.project('garden');
      await world.project('orchard');
      const task = await m.start('garden', 'Add a changelog.');
      await endRound(m, task.id);

      // Arguments that reach each tool's work; the spy is what counts.
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
        show_proposal: { proposalId: 'improve-1' },
        list_skills: {},
        list_tasks: {},
        show_task: { taskId: task.id },
        start_creation: { idea: 'A recipe box.' },
        cancel_creation: { creationId: creation.id },
        start_task: { project: 'orchard', description: 'Run the tests.' },
        propose_note_change: { section: 'lessons', text: 'Run the checks.\n' },
        set_usage_profile: { profile: 'saver' },
        prepare_improvement: { request: 'Run the checks after each round.' },
        add_skill: { url: 'https://github.com/acme/skills/tree/main/skills/other' },
        add_skill_to_project: { skill: 'tidy-notes', project: 'notes' },
      };
      // A new tool must be added here.
      expect(Object.keys(args).sort()).toEqual([...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS].sort());

      const reached: string[] = [];
      const refused: string[] = [];
      for (const name of CHAT_READ_TOOLS) {
        const definition = findChatTool(name) as ReadTool;
        try {
          await definition.run(chat.tools, parseArgs(definition, args[name]) as never);
          reached.push(name);
        } catch (error) {
          refused.push(`${name}: ${String(error)}`);
        }
      }
      for (const name of CHAT_ACTION_TOOLS) {
        const definition = findChatTool(name) as ActionTool;
        try {
          const proposal = await definition.propose(chat.tools, parseArgs(definition, args[name]) as never);
          await proposal.perform();
          reached.push(name);
        } catch (error) {
          refused.push(`${name}: ${String(error)}`);
        }
      }
      // Every tool did its work: none was refused before it.
      expect(refused).toEqual([]);
      expect(reached.sort()).toEqual([...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS].sort());
      expect(improvementCalls).toEqual(['suggestions', 'list', 'get improve-1', 'prepare Run the checks after each round.']);
      expect((await skills.list()).map((skill) => skill.name).sort()).toEqual(['other-notes', 'tidy-notes']);
      expect(chat.creations.get(creation.id).cancelling === true || chat.creations.get(creation.id).status === 'finished').toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs).toEqual([]);
      expect((await m.get(task.id)).state).toBe('proposal');
    } finally {
      await m.shutdown();
      await gh.close();
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
      await hit('POST /api/tasks/:id/checks/cancel', `/api/tasks/${id}/checks/cancel`, { confirm: true });
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

/**
 * What `file` (relative to src, with `/`) takes from `src/tasks/checks.ts`:
 * each name (`type X` for a type import), and any other way of loading it.
 */
function checksImports(file: string, text: string): string[] {
  const isChecks = (target: string) => path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/\.(js|ts)$/, '') === 'tasks/checks';
  const names: string[] = [];
  // Static imports and re-exports, on one line or several, aliases and a default name before the braces included, either quote.
  for (const found of text.matchAll(/\b(?:import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+)|\*|[\w$]+)\s*from\s*(['"])([^'"]+)\3/g)) {
    if (!isChecks(found[4] ?? '')) continue;
    const clause = found[2] ?? '';
    const braces = clause.indexOf('{');
    const list =
      braces === -1
        ? clause.split(',').map((name) => name.trim())
        : [
            ...clause.slice(0, braces).split(',').map((name) => name.trim()),
            ...clause
              .slice(braces + 1, clause.lastIndexOf('}'))
              .split(',')
              .map((name) => name.replace(/\s+/g, ' ').trim()),
          ];
    names.push(...list.filter((name) => name !== '').map((name) => `${found[1] === undefined ? '' : 'type '}${name}`));
  }
  // An import only for its side effects.
  for (const found of text.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) if (isChecks(found[2] ?? '')) names.push(`bare ${found[0]}`);
  // Nothing loads it another way: a dynamic import or require counts unless its target is a plain string that is not checks.ts.
  for (const found of text.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
    const plain = /^\s*(['"])([^'"]*)\1\s*$/.exec(found[1] ?? '');
    if (plain === null || isChecks(plain[2] ?? '')) names.push(`dynamic ${found[0]}`);
  }
  return names;
}

describe('what can run a check', () => {
  it('checks.ts exports nothing that runs a command but taskChecksWith', () => {
    // Runtime exports only (types vanish). `runChecks`, which spawns, is not one of them.
    // The pure helpers (`readChecks`, `writeChecks`, `checkCommandProblem`, `checkEnv`,
    // `cleanOutput`) run nothing; they stay exported because tests/unit/tasks-checks.test.ts tests them.
    expect(Object.keys(checksModule).sort()).toEqual(
      ['MAX_CHECKS', 'MAX_CHECK_LENGTH', 'checkCommandProblem', 'checkEnv', 'cleanOutput', 'projectChecks', 'readChecks', 'setProjectChecks', 'taskChecksWith', 'writeChecks'].sort(),
    );
  });

  it('the importers\' reading finds every form of import of checks.ts', () => {
    const file = 'server/x.ts';
    // Soft: a failure names every form the reading misses.
    expect.soft(checksImports(file, "import { readChecks } from '../tasks/checks.js';")).toEqual(['readChecks']);
    expect.soft(checksImports(file, "import type {\n  TaskChecks,\n  ProjectCheck as P,\n} from '../tasks/checks.js';")).toEqual(['type TaskChecks', 'type ProjectCheck as P']);
    expect.soft(checksImports(file, "export * from '../tasks/checks.js';")).toEqual(['*']);
    expect.soft(checksImports(file, "import * as c from '../tasks/checks.js';")).toEqual(['* as c']);
    expect.soft(checksImports(file, "import other, { readChecks } from '../tasks/checks.js';")).toEqual(['other', 'readChecks']);
    expect.soft(checksImports(file, 'import { readChecks } from "../tasks/checks.js";')).toEqual(['readChecks']);
    expect.soft(checksImports(file, 'const c = await import(`../tasks/checks.js`);')).toEqual(['dynamic import(`../tasks/checks.js`)']);
    expect.soft(checksImports(file, "import '../tasks/checks.js';")).toEqual(["bare import '../tasks/checks.js'"]);
    // A target the reading cannot know counts; a plain one elsewhere does not.
    expect.soft(checksImports(file, 'const c = await import(name);')).toEqual(['dynamic import(name)']);
    expect.soft(checksImports(file, "const m = await import('node:fs');")).toEqual([]);
    // Another module of the same name, elsewhere, is not it.
    expect.soft(checksImports(file, "import { x } from '../improve/checks.js';")).toEqual([]);
  });

  it('in src, only the server\'s wiring takes taskChecksWith; the routes take the note\'s functions, the manager its type', async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => file.split(path.sep).join('/'));
    const importers: Record<string, string[]> = {};
    for (const file of files) {
      if (file === 'tasks/checks.ts') continue;
      const names = checksImports(file, await readFile(path.join(SRC, file), 'utf8'));
      if (names.length > 0) importers[file] = names;
    }
    expect(importers).toEqual({
      'server/tasks.ts': ['MAX_CHECK_LENGTH', 'MAX_CHECKS', 'projectChecks', 'setProjectChecks'],
      'tasks/manager.ts': ['type TaskChecks'],
      'tasks/wiring.ts': ['taskChecksWith'],
    });
  });
});

import { request } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathEnv } from '../../src/config/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

useHermeticGit();

const TOKEN = 't'.repeat(43);

let world: TaskWorld;
let server: WebServer | undefined;
let manager: TaskManager | undefined;
let pathEnv: PathEnv;

function send(urlPath: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = server?.port ?? 0;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method ?? 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          [TOKEN_HEADER]: TOKEN,
          origin: `http://127.0.0.1:${port}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
    req.end(body);
  });
}

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

beforeEach(async () => {
  world = await taskWorld('server-tasks');
  await writeTree(path.join(world.dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
  pathEnv = { env: { BRIEFSTACK_HOME: world.home, BRIEFSTACK_LIBRARY: world.library }, homedir: path.join(world.dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
});

afterEach(async () => {
  await manager?.shutdown();
  await server?.close();
  manager = undefined;
  server = undefined;
  await world.cleanup();
});

async function start(withTasks = true): Promise<void> {
  if (withTasks) {
    manager = new TaskManager({
      runner: new TaskFakeRunner({ script: () => ({ steps: [{ kind: 'shell', command: 'npm test' }, { kind: 'write', file: 'CHANGES.md', content: 'Done.\n' }, { kind: 'end', summary: 'Wrote CHANGES.md.' }] }) }),
      store: world.store,
      sessionsDir: world.sessions,
      locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
      lang: () => 'en',
      profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
      pollMs: 10,
      afterRound: afterRoundWith({ libraryDir: async () => world.library, home: world.home }),
    });
  }
  server = await startWebServer({ port: 0, uiDir: path.join(world.dir, 'ui'), token: TOKEN, lang: 'en', pathEnv, repoDir: world.repo, ...(manager === undefined ? {} : { tasks: manager }) });
}

describe('task API', { timeout: 60_000 }, () => {
  it('answers 503 without a task manager', async () => {
    await start(false);
    expect((await send('/api/tasks')).status).toBe(503);
    expect((await send('/api/tasks', { method: 'POST', body: { project: 'garden', description: 'x' } })).json).toMatchObject({ code: 'task.unavailable' });
  });

  it('starts a task, answers its dialog, finishes the round, shows the proposal and approves it', async () => {
    const project = await world.project('garden');
    await world.initLibrary();
    await start();
    const page = await send('/api/projects/garden/tasks');
    expect(page.json).toMatchObject({ tasks: [], checks: [], start: { ok: true, branch: 'main', uncommitted: [] } });

    const created = await send('/api/tasks', { method: 'POST', body: { project: 'garden', description: 'Add a changelog.' } });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    await until(async () => (await send(`/api/tasks/${id}`)).json.pending !== undefined, 'the dialog');
    const pending = (await send(`/api/tasks/${id}`)).json.pending as { id: string; kind: string; payload: { text: string } };
    expect(pending).toMatchObject({ kind: 'approval', payload: { text: 'npm test' } });
    expect((await send(`/api/tasks/${id}/answer`, { method: 'POST', body: { pendingId: pending.id, answer: 'always' } })).status).toBe(400);
    expect((await send(`/api/tasks/${id}/answer`, { method: 'POST', body: { pendingId: pending.id, answer: 'once' } })).status).toBe(200);
    await until(async () => (await send(`/api/tasks/${id}`)).json.awaitingReply !== undefined, 'the turn');
    expect((await send(`/api/tasks/${id}/finish`, { method: 'POST' })).status).toBe(200);
    await until(async () => (await send(`/api/tasks/${id}`)).json.state === 'proposal', 'the proposal');

    const proposal = await send(`/api/tasks/${id}/proposal`);
    expect(proposal.json).toMatchObject({ task: { state: 'proposal', checks: [], validations: [] }, diff: { files: [{ path: 'CHANGES.md', status: 'added' }] } });

    // Approving needs the page's confirmation in the body.
    expect((await send(`/api/tasks/${id}/approve`, { method: 'POST', body: {} })).status).toBe(400);
    const approved = await send(`/api/tasks/${id}/approve`, { method: 'POST', body: { confirm: true } });
    expect(approved.json).toMatchObject({ state: 'applied' });
    expect(await readFile(path.join(project, 'CHANGES.md'), 'utf8')).toBe('Done.\n');

    const reverted = await send(`/api/tasks/${id}/revert`, { method: 'POST', body: { confirm: true } });
    expect(reverted.json).toMatchObject({ state: 'reverted' });
    expect((await send('/api/tasks')).json.tasks).toHaveLength(1);
  });

  it('refuses to approve into a dirty folder with the reason, asks for changes, and discards', async () => {
    const project = await world.project('garden');
    await start();
    const id = (await send('/api/tasks', { method: 'POST', body: { project: 'garden', description: 'Add a changelog.' } })).json.id as string;
    await until(async () => (await send(`/api/tasks/${id}`)).json.pending !== undefined, 'the dialog');
    const pending = (await send(`/api/tasks/${id}`)).json.pending as { id: string };
    await send(`/api/tasks/${id}/answer`, { method: 'POST', body: { pendingId: pending.id, answer: 'task' } });
    await until(async () => (await send(`/api/tasks/${id}`)).json.awaitingReply !== undefined, 'the turn');
    await send(`/api/tasks/${id}/finish`, { method: 'POST' });
    await until(async () => (await send(`/api/tasks/${id}`)).json.state === 'proposal', 'the proposal');

    await writeTree(project, { 'draft.txt': 'x\n' });
    const refused = await send(`/api/tasks/${id}/approve`, { method: 'POST', body: { confirm: true } });
    expect(refused).toMatchObject({ status: 409, json: { code: 'task.dirtyFolder' } });
    expect(refused.json.message).toContain('uncommitted changes');
    await rm(path.join(project, 'draft.txt'));

    // A new round on the same worktree: "npm test" is still allowed for the task, so nothing is asked.
    const again = await send(`/api/tasks/${id}/changes`, { method: 'POST', body: { text: 'Also a date.' } });
    expect(again.json).toMatchObject({ state: 'running', rounds: [{ n: 1 }, { n: 2, text: 'Also a date.' }] });
    await until(async () => (await send(`/api/tasks/${id}`)).json.awaitingReply !== undefined, 'the second turn');
    expect((await send(`/api/tasks/${id}`)).json.pending).toBeUndefined();
    await send(`/api/tasks/${id}/finish`, { method: 'POST' });
    await until(async () => (await send(`/api/tasks/${id}`)).json.state === 'proposal', 'the second proposal');

    const discarded = await send(`/api/tasks/${id}/discard`, { method: 'POST', body: { confirm: true } });
    expect(discarded.json).toMatchObject({ state: 'discarded' });
    expect((await gitIn(project, 'branch', '--list', 'briefstack/*')).trim()).toBe('');
  });

  it('refuses a claude-app project with its reason, sets confirmed checks, and offers git init only to a folder outside git', async () => {
    await world.project('app', {}, { target: 'claude-app' });
    const plain = await world.project('plain');
    await world.initLibrary();
    await start();
    const refused = await send('/api/tasks', { method: 'POST', body: { project: 'app', description: 'x' } });
    expect(refused).toMatchObject({ status: 409, json: { code: 'task.notClaudeCode' } });
    expect((await send('/api/projects/app/tasks')).json.start).toMatchObject({ ok: false, code: 'task.notClaudeCode' });

    expect((await send('/api/projects/plain/checks', { method: 'PUT', body: { commands: ['npm test'] } })).status).toBe(400);
    const set = await send('/api/projects/plain/checks', { method: 'PUT', body: { commands: ['npm test'], confirm: true } });
    expect(set.json).toEqual({ checks: [{ command: 'npm test', confirmed: true }] });

    expect((await send('/api/projects/plain/git-init', { method: 'POST', body: { confirm: true } })).json).toMatchObject({ code: 'task.alreadyRepo' });
    await rm(path.join(plain, '.git'), { recursive: true, force: true });
    expect((await send('/api/projects/plain/tasks')).json.start).toMatchObject({ ok: false, code: 'task.notGitRepo' });
    const init = await send('/api/projects/plain/git-init', { method: 'POST', body: { confirm: true } });
    expect(init.json.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await send('/api/projects/plain/tasks')).json.start).toMatchObject({ ok: true });
  });
});

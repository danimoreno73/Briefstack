import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS } from '../../src/chat/toolNames.js';
import { ChatToolError, findChatTool, parseArgs, resultText, type ActionTool, type ReadTool, type ToolOutcome } from '../../src/chat/tools.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { FAKE_KEY, chatWorld, type ChatWorld } from '../chatWorld.js';
import { useHermeticGit, writeTree } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

useHermeticGit();

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('task tools of the chat', { timeout: 60_000 }, () => {
  let world: ChatWorld;
  let tasks: TaskWorld;
  let manager: TaskManager;
  let runner: TaskFakeRunner;

  const open = (script?: TaskFakeScript): TaskManager => {
    runner = new TaskFakeRunner(script === undefined ? {} : { script });
    manager = new TaskManager({
      runner,
      store: tasks.store,
      sessionsDir: tasks.sessions,
      locations: async () => ({ libraryDir: tasks.library, repoDir: tasks.repo }),
      lang: () => 'en',
      profile: async () => ({ name: 'balanced', model: 'sonnet', effort: 'medium' }),
      creations: { activeIds: () => world.creations.activeIds(), folderHolder: () => undefined },
      maxActive: () => 2,
      pollMs: 10,
    });
    return manager;
  };

  beforeEach(async () => {
    world = await chatWorld();
    tasks = await taskWorld('chat-tasks');
    open();
    world.tools.tasks = () => manager;
  });
  afterEach(async () => {
    await manager.shutdown();
    await world.cleanup();
    await tasks.cleanup();
  });

  const read = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const definition = findChatTool(name) as ReadTool;
    return definition.run(world.tools, parseArgs(definition, args) as never);
  };
  const propose = async (name: string, args: Record<string, unknown>) => {
    const definition = findChatTool(name) as ActionTool;
    return definition.propose(world.tools, parseArgs(definition, args) as never);
  };
  const stateIs = (id: string, state: string) => until(async () => (await manager.get(id)).state === state, `state ${state}`);

  it('has two read tools and one action, and nothing that approves, asks for changes, discards or reverts', () => {
    expect(CHAT_READ_TOOLS).toEqual(expect.arrayContaining(['list_tasks', 'show_task']));
    expect(CHAT_ACTION_TOOLS).toContain('start_task');
    for (const name of [...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS]) expect(name).not.toMatch(/approve|apply|discard|revert|changes|round/);
  });

  it('start_task shows a card with the project, the text, the work model and effort, and starts only when performed', async () => {
    const folder = await tasks.project('garden');
    await writeTree(folder, { 'scratch.txt': 'not committed\n' });
    const proposal = await propose('start_task', { project: 'garden', description: 'Add a changelog.' });
    expect(proposal.card).toEqual({
      kind: 'startTask',
      project: 'garden',
      description: 'Add a changelog.',
      profile: 'balanced',
      model: 'sonnet',
      effort: 'medium',
      active: 0,
      limit: 2,
      uncommitted: 1,
    });
    // Proposing is not doing.
    expect(runner.started).toHaveLength(0);
    expect(await manager.list()).toHaveLength(0);

    const done = await proposal.perform();
    const id = (done.data as { taskId: string }).taskId;
    expect(done.data).toMatchObject({ started: true, taskId: id, note: expect.stringContaining("task's page") });
    expect(done.sources).toEqual([{ kind: 'task', ref: id, label: 'Add a changelog.' }]);
    expect(runner.started).toHaveLength(1);
    expect(runner.started[0]?.prompt).toContain('Add a changelog.');
  });

  it('start_task counts running creations and tasks together, on the card and at the limit', async () => {
    await tasks.project('garden');
    await tasks.project('orchard');
    await world.creations.create('A recipe box');
    const proposal = await propose('start_task', { project: 'garden', description: 'Add a changelog.' });
    expect(proposal.card).toMatchObject({ kind: 'startTask', active: 1, limit: 2 });
    await manager.start('orchard', 'Add a readme.');
    await expect(propose('start_task', { project: 'garden', description: 'Add a changelog.' })).rejects.toThrow(/creations and tasks count together.*Nothing was proposed/);
  });

  it('start_task refuses without a card: a secret, an unknown project, a claude-app project, a second task on the project, the limit', async () => {
    await tasks.project('garden');
    await expect(propose('start_task', { project: 'garden', description: `Deploy it\nkey ${FAKE_KEY}` })).rejects.toThrow(/looks like a secret on line 2.*Nothing was proposed/);
    await expect(propose('start_task', { project: 'nowhere', description: 'x' })).rejects.toBeInstanceOf(ChatToolError);
    await tasks.project('notes-app', {}, { target: 'claude-app' });
    await expect(propose('start_task', { project: 'notes-app', description: 'x' })).rejects.toThrow(/Nothing was proposed/);

    await manager.start('garden', 'First.');
    await expect(propose('start_task', { project: 'garden', description: 'Second.' })).rejects.toThrow(/Nothing was proposed/);

    await tasks.project('orchard');
    await tasks.project('meadow');
    await manager.start('orchard', 'Another.');
    await expect(propose('start_task', { project: 'meadow', description: 'Third.' })).rejects.toThrow(/Nothing was proposed/);
    expect(runner.started).toHaveLength(2);
  });

  it('list_tasks and show_task give the state, the diff summary and the checks, no paths, and point at the page', async () => {
    await tasks.project('garden');
    await tasks.project('orchard');
    const first = await manager.start('garden', 'Add a changelog.');
    await until(async () => (await manager.get(first.id)).awaitingReply !== undefined, 'the turn to end');
    const running = await read('list_tasks');
    expect(running.data).toMatchObject({ tasks: [{ taskId: first.id, project: 'garden', state: 'running', rounds: 1, waitingFor: 'reply' }] });

    manager.finishRound(first.id);
    await stateIs(first.id, 'proposal');
    const other = await manager.start('orchard', 'Add a readme.');

    const all = await read('list_tasks');
    expect((all.data as { tasks: { taskId: string }[] }).tasks.map((task) => task.taskId)).toEqual(expect.arrayContaining([first.id, other.id]));
    const filtered = await read('list_tasks', { project: 'garden' });
    expect(filtered.data).toMatchObject({ tasks: [{ taskId: first.id, state: 'proposal' }], note: expect.stringContaining("task's page") });
    expect(filtered.sources).toEqual([{ kind: 'task', ref: first.id, label: 'Add a changelog.' }]);

    const shown = await read('show_task', { taskId: first.id });
    expect(shown.data).toMatchObject({
      taskId: first.id,
      state: 'proposal',
      rounds: [{ n: 1, outcome: 'completed', summary: 'Wrote CHANGES.md (round 1).' }],
      diff: { files: [{ path: 'CHANGES.md', status: 'added', added: 1, removed: 0 }] },
      checks: { ran: false },
      validations: [],
    });
    // Once the user ran them on the page: how many failed, each exit code, no output.
    await manager.shutdown();
    manager = new TaskManager({
      runner,
      store: tasks.store,
      sessionsDir: tasks.sessions,
      locations: async () => ({ libraryDir: tasks.library, repoDir: tasks.repo }),
      lang: () => 'en',
      profile: async () => ({ name: 'balanced', model: 'sonnet', effort: 'medium' }),
      maxActive: () => 2,
      checks: {
        commands: async () => ['npm test', 'npm run lint'],
        run: async (_dir, commands) => commands.map((command, i) => ({ command, exitCode: i === 0 ? 0 : 2, timedOut: false, output: 'secret output', durationMs: 5 })),
      },
    });
    await manager.runChecks(first.id, ['npm test', 'npm run lint']);
    await stateIs(first.id, 'proposal');
    const checked = await read('show_task', { taskId: first.id });
    expect(checked.data).toMatchObject({
      checks: {
        ran: true,
        failed: 1,
        results: [
          { command: 'npm test', exitCode: 0, timedOut: false },
          { command: 'npm run lint', exitCode: 2, timedOut: false },
        ],
      },
    });
    expect(resultText(checked)).not.toContain('secret output');
    const text = resultText(shown);
    expect(text).toContain("task's page");
    expect(text).not.toContain(tasks.dir.replaceAll('\\', '\\\\'));
    expect(text).not.toContain(tasks.dir);
    await expect(read('show_task', { taskId: 'abcdef-0000' })).rejects.toMatchObject({ code: 'task.notFound' });
  });

  it('list_tasks hides a secret in the task text', async () => {
    await tasks.project('garden');
    const task = await manager.start('garden', `Rotate it\nkey ${FAKE_KEY}`);
    const listed = await read('list_tasks');
    expect(resultText(listed)).not.toContain(FAKE_KEY);
    expect(listed.data).toMatchObject({ tasks: [{ taskId: task.id }] });
  });

  it('cancel_creation takes a running task id: a card naming the task, cancelled only when performed', async () => {
    await tasks.project('garden');
    const task = await manager.start('garden', 'Add a changelog.');
    await until(async () => (await manager.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    const proposal = await propose('cancel_creation', { creationId: task.id });
    expect(proposal.card).toEqual({ kind: 'cancelTask', taskId: task.id, project: 'garden', description: 'Add a changelog.' });
    expect((await manager.get(task.id)).cancelling).toBeUndefined();
    const done = await proposal.perform();
    expect(done.data).toEqual({ cancelling: true });
    expect(done.sources).toEqual([{ kind: 'task', ref: task.id }]);
    await stateIs(task.id, 'cancelled');
    // A cancelled task keeps its worktree, for a new round or a discard on its page.
    await expect(stat(path.join(tasks.store.worktreeDir(task.id)))).resolves.toBeDefined();
    await expect(propose('cancel_creation', { creationId: task.id })).rejects.toThrow(/not running \(it is cancelled\)/);
  });

  it('says so when tasks are not available', async () => {
    world.tools.tasks = undefined;
    await expect(read('list_tasks')).rejects.toThrow(/not available/);
    await expect(propose('start_task', { project: 'garden', description: 'x' })).rejects.toThrow(/not available/);
  });
});

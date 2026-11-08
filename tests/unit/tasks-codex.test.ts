import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodexToolResult } from '../../src/codex/tool.js';
import { CODEX_TOOL_ID } from '../../src/codex/toolNames.js';
import type { TrackedSpawn } from '../../src/creation/processTree.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { evaluateTaskToolUse } from '../../src/tasks/guard.js';
import { decideTaskToolUse, writeTaskRulesSync } from '../../src/tasks/guardCommand.js';
import { TaskManager, type TaskManagerOptions } from '../../src/tasks/manager.js';
import type { TaskRunnerStartOptions } from '../../src/tasks/runner.js';
import { TaskSdkRunner } from '../../src/tasks/sdkRunner.js';
import { TaskApprovals } from '../../src/tasks/shell.js';
import { taskRecordSchema } from '../../src/tasks/types.js';
import { fakeCodex } from '../codexWorld.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// `delegate_to_codex` in task sessions (decisions.md, "Phase 8: step 25"):
// the guard registers it, the session offers it only when Settings allows,
// and each call is kept in its round's record.

useHermeticGit();

const until = async (check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 2000; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

describe('the task guard and delegate_to_codex', () => {
  const worktree = path.resolve('work');

  it('allows it only when the round offers it, and only from the main session', async () => {
    const call = { tool_name: CODEX_TOOL_ID, tool_input: { instruction: 'Go.' } };
    expect(await evaluateTaskToolUse({ worktree, skills: [] }, call)).toMatchObject({ verdict: 'deny', reason: 'Codex is not available in this task.' });
    expect(await evaluateTaskToolUse({ worktree, skills: [], codex: false }, call)).toMatchObject({ verdict: 'deny' });
    expect(await evaluateTaskToolUse({ worktree, skills: [], codex: true }, call)).toMatchObject({ verdict: 'allow' });
    expect(await evaluateTaskToolUse({ worktree, skills: [], codex: true }, { ...call, agent_id: 'agent-1' })).toMatchObject({ verdict: 'deny', reason: "Only the task's main session hands work to Codex." });
  });

  it('another server\'s tool of the same name is still refused', async () => {
    expect(await evaluateTaskToolUse({ worktree, skills: [], codex: true }, { tool_name: 'mcp__other__delegate_to_codex', tool_input: {} })).toMatchObject({ verdict: 'deny' });
  });

  it('the command-hook guard follows the rules file: codex true allows it; absent (older files too) denies it', async () => {
    const { dir, cleanup } = await tempDir('tasks-codex-hook');
    try {
      const rulesFile = path.join(dir, 'guard.json');
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: CODEX_TOOL_ID, tool_input: { instruction: 'Go.' }, tool_use_id: 'toolu_1' });
      const base = { v: 1 as const, worktree: path.join(dir, 'work'), skills: [], approvalsDir: path.join(dir, 'approvals'), serverPid: process.pid, cancelled: false };
      writeTaskRulesSync(rulesFile, base);
      expect((await decideTaskToolUse(input, rulesFile)).code).toBe(2);
      writeTaskRulesSync(rulesFile, { ...base, codex: true });
      expect(await decideTaskToolUse(input, rulesFile)).toEqual({ code: 0 });
      writeTaskRulesSync(rulesFile, { ...base, codex: true, cancelled: true });
      expect((await decideTaskToolUse(input, rulesFile)).code).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

/** A query that only ends when it is closed. */
class IdleQuery {
  private stop: (() => void) | undefined;
  close(): void {
    this.stop?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
    return { next: () => new Promise((resolve) => (this.stop = () => resolve({ value: undefined, done: true }))) };
  }
}

describe('the SDK session', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('tasks-codex-sdk'));
  });
  afterEach(() => cleanup());

  async function startWith(codex: boolean): Promise<{ options: Options; rules: Record<string, unknown> }> {
    let options: Options | undefined;
    const query = new IdleQuery();
    const runner = new TaskSdkRunner({
      pathEnv: { env: { PATH: 'x' }, homedir: dir, pathApi: path, caseInsensitive: process.platform !== 'linux' },
      query: (params) => {
        options = params.options;
        return query as unknown as Query;
      },
      findExecutable: () => '/bin/claude',
      tracked: () => ({ spawn: () => { throw new Error('not used'); }, killTree: async () => undefined }) as unknown as TrackedSpawn,
    });
    const taskDir = path.join(dir, 'home', 'tasks', 'abc123-0f0f');
    const worktree = path.join(taskDir, 'work');
    await writeTree(worktree, { 'a.txt': 'a\n' });
    const start: TaskRunnerStartOptions = {
      taskId: 'abc123-0f0f',
      project: 'garden',
      round: 1,
      prompt: 'Do the task.',
      worktree,
      model: 'sonnet',
      effort: 'low',
      sessionsDir: path.join(dir, 'home', 'sessions'),
      skills: [],
      restrictions: { deny: [], ask: [] },
      rulesFile: path.join(taskDir, 'guard.json'),
      approvalsDir: path.join(taskDir, 'approvals'),
      approvals: new TaskApprovals(path.join(taskDir, 'approvals'), async () => 'deny'),
      ...(codex ? { codex: { command: fakeCodex(), maxCalls: 3, outDir: path.join(taskDir, 'codex') } } : {}),
      io: { askQuestions: async () => ({ decision: 'cancel' }), emit: () => undefined },
    };
    const handle = runner.start(start);
    await until(() => options !== undefined, 'the query');
    const rules = JSON.parse(await readFile(start.rulesFile, 'utf8')) as Record<string, unknown>;
    await handle.stop();
    return { options: options as Options, rules };
  }

  it('with Codex on, only the task\'s own server, with only delegate_to_codex; the rules say so', async () => {
    const { options, rules } = await startWith(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['briefstack-task']);
    expect(options.strictMcpConfig).toBe(true);
    // The built-in tools and the skills option do not change.
    expect(options.tools).not.toContain(CODEX_TOOL_ID);
    expect(options.skills).toEqual([]);
    expect(rules.codex).toBe(true);
  });

  it('with Codex off, no MCP server at all, and the rules leave it out', async () => {
    const { options, rules } = await startWith(false);
    expect(options.mcpServers).toEqual({});
    expect(rules.codex).toBeUndefined();
  });
});

describe('the manager: Codex calls in the round\'s record', { timeout: 60_000 }, () => {
  let world: TaskWorld;
  let log: string;
  let managers: TaskManager[];

  beforeEach(async () => {
    world = await taskWorld('tasks-codex');
    log = path.join(world.dir, 'codex-calls.jsonl');
    await writeFile(log, '', 'utf8');
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) await m.shutdown();
    await world.cleanup();
  });

  function manager(script: TaskFakeScript, codex: TaskManagerOptions['codex']): TaskManager {
    const m = new TaskManager({
      runner: new TaskFakeRunner({ script }),
      store: world.store,
      sessionsDir: world.sessions,
      locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
      lang: () => 'en',
      profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
      maxActive: () => 2,
      pollMs: 10,
      afterRound: afterRoundWith(),
      ...(codex === undefined ? {} : { codex }),
    });
    managers.push(m);
    return m;
  }

  const offered = async () => ({ command: fakeCodex(log), maxCalls: 2 });

  it('each call is kept in its round, its message without absolute paths; the round\'s end keeps them', async () => {
    const results: CodexToolResult[] = [];
    const m = manager(
      () => ({
        steps: [
          { kind: 'codex', instruction: 'Add a note.', results },
          { kind: 'codex', instruction: '[fake:fail]', results },
          { kind: 'codex', instruction: 'Third.', results },
          { kind: 'end', summary: 'Done.' },
        ],
      }),
      offered,
    );
    await world.project('garden');
    const task = await m.start('garden', 'Use Codex.');
    await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
    m.finishRound(task.id);
    await until(async () => (await m.get(task.id)).state === 'proposal', 'the proposal');
    const record = await world.store.load(task.id);
    const codex = record?.rounds[0]?.codex;
    expect(codex?.map((call) => [call.n, call.outcome, call.exitCode])).toEqual([
      [1, 'completed', 0],
      [2, 'failed', 1],
    ]);
    expect(codex?.[0]).toMatchObject({ usage: { input: 1200, cached: 1000, output: 50, reasoning: 7 }, commands: 1, message: 'I wrote codex-note.txt.' });
    // The third call passed the cap of 2: Claude was told, Codex never ran it.
    expect(results.map((result) => result.isError)).toEqual([false, true, true]);
    expect(results[2]?.text).toContain('the most the user allows (2)');
    // Codex's file is in the round's commit, like any other change of the session.
    expect((await m.proposal(task.id)).diff?.files.map((file) => file.path)).toContain('codex-note.txt');
    // Codex's -o files stay out of the worktree.
    expect(existsSync(path.join(world.store.worktreeDir(task.id), 'call-1.txt'))).toBe(false);
  });

  it('when Settings does not offer it (or reading Settings fails), the guard refuses the tool and nothing runs', async () => {
    for (const codex of [undefined, async () => undefined, async () => Promise.reject(new Error('config'))] as TaskManagerOptions['codex'][]) {
      const m = manager(() => ({ steps: [{ kind: 'codex', instruction: 'Go.' }, { kind: 'end', summary: 'Done.' }] }), codex);
      const slug = `garden${managers.length}`;
      await world.project(slug);
      const task = await m.start(slug, 'Use Codex.');
      const denied: unknown[] = [];
      m.subscribe(task.id, 0, (event) => {
        if (event.kind === 'denied') denied.push(event.data);
      });
      await until(async () => (await m.get(task.id)).awaitingReply !== undefined, 'the turn to end');
      expect(denied).toMatchObject([{ toolName: CODEX_TOOL_ID, reason: 'Codex is not available in this task.' }]);
      expect((await world.store.load(task.id))?.rounds[0]?.codex).toBeUndefined();
      await m.discard(task.id).catch(() => undefined);
      await m.cancel(task.id);
    }
    expect(await readFile(log, 'utf8')).toBe('');
  });

  it('cancelling the task while Codex works ends its process tree; the call is recorded as cancelled', async () => {
    const m = manager(() => ({ steps: [{ kind: 'codex', instruction: '[fake:slow]' }, { kind: 'end', summary: 'Done.' }] }), offered);
    await world.project('garden');
    const task = await m.start('garden', 'Use Codex.');
    const outDir = path.join(world.store.taskDir(task.id), 'codex');
    let heartbeat = '';
    await until(async () => {
      if (!existsSync(outDir)) return false;
      const name = (await readdir(outDir)).find((file) => file.endsWith('.heartbeat'));
      if (name !== undefined) heartbeat = path.join(outDir, name);
      return name !== undefined;
    }, 'Codex to start');
    const child = (JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number }).pid;
    m.cancel(task.id);
    await until(async () => (await m.get(task.id)).state === 'cancelled', 'the cancel');
    expect((await world.store.load(task.id))?.rounds[0]?.codex?.map((call) => call.outcome)).toEqual(['cancelled']);
    await until(() => !alive(child), 'Codex\'s child to be gone');
  });

  it('while a call runs the task says Codex is working; a call that ended, a cancel or a refused call do not', async () => {
    const m = manager(
      () => ({ steps: [{ kind: 'codex', instruction: 'Add a note.' }, { kind: 'codex', instruction: '[fake:slow]' }, { kind: 'end', summary: 'Done.' }] }),
      offered,
    );
    await world.project('garden');
    const task = await m.start('garden', 'Use Codex.');
    // The first call ended (its record is saved), the second one runs.
    await until(async () => (await m.get(task.id)).rounds[0]?.codex?.length === 1, 'the first call');
    await until(async () => (await m.get(task.id)).codexWorking === true, 'Codex working');
    m.cancel(task.id);
    // Cancelling: the page says so, not that Codex works.
    expect((await m.get(task.id)).codexWorking).toBeUndefined();
    await until(async () => (await m.get(task.id)).state === 'cancelled', 'the cancel');
    expect((await m.get(task.id)).codexWorking).toBeUndefined();

    // A call the guard refuses (the round does not offer the tool) never shows as working once refused.
    const off = manager(() => ({ steps: [{ kind: 'codex', instruction: 'Go.' }, { kind: 'end', summary: 'Done.' }] }), async () => undefined);
    await world.project('garden2');
    const refused = await off.start('garden2', 'Use Codex.');
    const lines: string[] = [];
    off.subscribe(refused.id, 0, (event) => {
      const type = (event.data as { type?: string }).type;
      if ((event.kind === 'hook' || event.kind === 'runner') && type !== undefined) lines.push(type);
    });
    await until(async () => (await off.get(refused.id)).awaitingReply !== undefined, 'the turn to end');
    // Both of the call's lines were read: its start, then its refusal.
    await until(() => lines.includes('tool.pre') && lines.includes('tool.denied'), 'the refusal to be read');
    expect((await off.get(refused.id)).codexWorking).toBeUndefined();
  });

  it('a server stop while Codex works ends its process tree too', async () => {
    const m = manager(() => ({ steps: [{ kind: 'codex', instruction: '[fake:slow]' }, { kind: 'end', summary: 'Done.' }] }), offered);
    await world.project('garden');
    const task = await m.start('garden', 'Use Codex.');
    const outDir = path.join(world.store.taskDir(task.id), 'codex');
    let heartbeat = '';
    await until(async () => {
      if (!existsSync(outDir)) return false;
      const name = (await readdir(outDir)).find((file) => file.endsWith('.heartbeat'));
      if (name !== undefined) heartbeat = path.join(outDir, name);
      return name !== undefined;
    }, 'Codex to start');
    const child = (JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number }).pid;
    await m.shutdown();
    expect((await world.store.load(task.id))?.state).toBe('interrupted');
    await until(() => !alive(child), 'Codex\'s child to be gone');
  });

  it('a record saved before Codex existed still reads, with no calls', async () => {
    const old = {
      v: 1,
      id: 'mabc12-0f0f',
      project: 'garden',
      projectDir: path.join(world.projects, 'garden'),
      description: 'Old.',
      profile: 'saver',
      model: 'sonnet',
      effort: 'low',
      state: 'proposal',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      branch: 'briefstack/task-mabc12-0f0f',
      hidden: [],
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      rounds: [{ n: 1, text: 'Old.', startedAt: '2026-11-01T10:00:00.000Z', finishedAt: '2026-11-01T10:05:00.000Z', outcome: 'completed', summary: 'Done.' }],
    };
    expect(taskRecordSchema.safeParse(old).success).toBe(true);
    await mkdir(world.store.taskDir(old.id), { recursive: true });
    await writeFile(world.store.recordFile(old.id), JSON.stringify(old), 'utf8');
    const loaded = await world.store.load(old.id);
    expect(loaded?.rounds[0]?.codex).toBeUndefined();
    expect(loaded?.rounds[0]?.summary).toBe('Done.');
  });
});

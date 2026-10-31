import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS } from '../../src/chat/toolNames.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { useHermeticGit } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// The declared checks run project code the session changed, so they run on
// one path only: the user's request on the proposal page (decisions.md, S8).
// Nothing else may run them: not the round's end, a new round, approving,
// discarding, reverting, a server start, or the chat.

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

beforeEach(async () => {
  world = await taskWorld('tasks-checks-invariant');
});
afterEach(() => world.cleanup());

describe('only the user\'s request runs the declared checks', { timeout: 60_000 }, () => {
  it('no other action of a task runs them, through the whole life of two tasks', async () => {
    const calls: string[] = [];
    const checks: TaskChecks = { commands: async () => ['npm test'], run: async (_dir, commands) => (calls.push(...commands), []) };
    const open = () =>
      new TaskManager({
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
    const m = open();
    await world.project('garden');
    const endRound = async (id: string) => {
      await until(async () => (await m.get(id)).awaitingReply !== undefined, 'the turn to end');
      m.finishRound(id);
      await until(async () => (await m.get(id)).state === 'proposal', 'the proposal');
    };

    // Start, the round's end, reading it (what the page and the chat read), a new round, approve, revert.
    const first = await m.start('garden', 'Add a changelog.');
    await endRound(first.id);
    await m.get(first.id);
    await m.list();
    expect((await m.proposal(first.id)).checkCommands).toEqual(['npm test']);
    await m.newRound(first.id, 'More.');
    await endRound(first.id);
    await m.approve(first.id);
    await m.revert(first.id);

    // Another task: discarded; a third one cut short by a server stop and recovered.
    const second = await m.start('garden', 'Something else.');
    await endRound(second.id);
    await m.discard(second.id);
    const third = await m.start('garden', 'A third.');
    await endRound(third.id);
    await m.shutdown();
    const fresh = open();
    await fresh.recover();
    expect(calls).toEqual([]);

    // The one path that does.
    await fresh.runChecks(third.id, ['npm test']);
    await until(async () => (await fresh.get(third.id)).state === 'proposal', 'the checks');
    expect(calls).toEqual(['npm test']);
    await fresh.shutdown();
  });

  it('the chat has no tool that runs them', () => {
    for (const name of [...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS]) expect(name).not.toMatch(/check/i);
  });

  it('in the code, the checks are run from the manager\'s request only, which only the proposal page\'s route calls', async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => file.split(path.sep).join('/'));
    /** The lines of code (not comments) of each source file that match `re`. */
    const where = async (re: RegExp): Promise<Record<string, string[]>> => {
      const found: Record<string, string[]> = {};
      for (const file of files) {
        const lines = (await readFile(path.join(SRC, file), 'utf8')).split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && re.test(line));
        if (lines.length > 0) found[file] = lines.map((line) => line.trim());
      }
      return found;
    };

    // `runChecks` from checks.ts: defined there and used only by the manager's checks (`taskChecksWith`).
    const runChecks = await where(/\brunChecks\(/);
    expect(Object.keys(runChecks).sort()).toEqual(['server/tasks.ts', 'tasks/checks.ts', 'tasks/manager.ts']);
    expect(runChecks['tasks/checks.ts']).toEqual([
      'run: (worktree, commands) => runChecks(worktree, commands, deps.options),',
      'export async function runChecks(worktree: string, commands: readonly string[], options: RunChecksOptions = {}): Promise<CheckResult[]> {',
    ]);
    // The manager's method is defined once; the only caller is the route of the proposal page.
    expect(runChecks['tasks/manager.ts']).toEqual(['runChecks(id: string, shown: readonly string[]): Promise<TaskView> {']);
    expect(runChecks['server/tasks.ts']).toEqual(['sendJson(res, 202, await need().runChecks(id(params), commands));']);
    expect(await where(/'POST \/api\/tasks\/:id\/checks'/)).toEqual({ 'server/tasks.ts': ["'POST /api/tasks/:id/checks',"] });

    // The manager's checks run in one place, `checkNow`, which only `runChecks` starts.
    const manager = (await readFile(path.join(SRC, 'tasks', 'manager.ts'), 'utf8')).split(/\r?\n/);
    const runs = manager.flatMap((line, i) => (/checks\??\.run\(/.test(line) ? [i] : []));
    expect(runs).toHaveLength(1);
    const method = manager.slice(0, runs[0]).findLast((line) => /^ {2}(private |async |public )*\w+\(/.test(line));
    expect(method?.trim()).toMatch(/^private async checkNow\(/);
    expect(manager.filter((line) => /this\.checkNow\(/.test(line))).toHaveLength(1);
    expect(await where(/\btaskChecksWith\(/)).toEqual({
      'tasks/checks.ts': ['export function taskChecksWith(deps: { libraryDir: () => Promise<string>; home: string; options?: RunChecksOptions }): TaskChecks {'],
      'tasks/wiring.ts': ['checks: taskChecksWith({ libraryDir, home: paths.home }),'],
    });
    // The chat's code never names them.
    for (const file of files.filter((name) => name.startsWith('chat/'))) expect(await readFile(path.join(SRC, file), 'utf8'), file).not.toMatch(/runChecks|checkNow|taskChecksWith/);
  });
});

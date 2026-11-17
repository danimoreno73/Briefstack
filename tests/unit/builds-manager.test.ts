import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrationHead } from '../../src/builds/git.js';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import type { PlanOutput } from '../../src/builds/types.js';
import type { UsageReading } from '../../src/builds/usage.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import type { TaskChecks } from '../../src/tasks/checks.js';
import { TaskFakeRunner, type TaskFakeScript, type TaskFakeStep } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import type { CheckResult } from '../../src/tasks/types.js';
import { useHermeticGit } from '../helpers.js';
import { gitIn, taskWorld, type TaskWorld } from '../taskWorld.js';

// Builds (BRIEF-phase-9 §3; PLAN-phase-9 M3 and M4) over the fake planner and
// the fake task runner, on a temp git repository.

useHermeticGit();

let world: TaskWorld;
let project: string;

const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- A list.\n- A total.\n- A report.\n';

const PLAN: PlanOutput = {
  tasks: [
    { title: 'List', instruction: 'Write LIST.md.', doneWhen: 'LIST.md exists.', dependsOn: [] },
    { title: 'Total', instruction: 'Write TOTAL.md.', doneWhen: 'TOTAL.md exists.', dependsOn: [] },
    { title: 'Report', instruction: 'Write REPORT.md from the total.', doneWhen: 'REPORT.md exists.', dependsOn: [2] },
  ],
  commands: ['npm test', 'npm run lint'],
  checks: ['npm test'],
};

/** Checks that fail while the worktree has a `BROKEN` file. */
function fileChecks(): { checks: TaskChecks; runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    checks: {
      commands: async () => [],
      run: async (worktree, commands): Promise<CheckResult[]> => {
        const broken = await access(path.join(worktree, 'BROKEN')).then(
          () => true,
          () => false,
        );
        runs.push(path.basename(path.dirname(worktree)));
        return commands.map((command) => ({ command, exitCode: broken ? 1 : 0, timedOut: false, output: broken ? 'FAIL: BROKEN is there' : 'ok', durationMs: 1 }));
      },
    },
  };
}

/** Each task writes its file; "Total" also leaves BROKEN, in every round, so its checks keep failing. */
const script: TaskFakeScript = (_round, prompt) => {
  const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'X';
  const steps: TaskFakeStep[] = [{ kind: 'write', file: `${title.toUpperCase()}.md`, content: `${title}.\n` }];
  if (title === 'Total') steps.push({ kind: 'write', file: 'BROKEN', content: 'x\n' });
  steps.push({ kind: 'end', summary: `Wrote ${title}.` });
  return { steps };
};

interface Setup {
  builds: BuildManager;
  tasks: TaskManager;
  runner: TaskFakeRunner;
  planner: FakeBuildPlanner;
  runs: string[];
  readings: UsageReading[];
}

function setup(options: { plan?: PlanOutput | Error; usage?: UsageReading[]; script?: TaskFakeScript } = {}): Setup {
  const holder: { builds?: BuildManager } = {};
  const runner = new TaskFakeRunner({ script: options.script ?? script });
  const { checks, runs } = fileChecks();
  const tasks = new TaskManager({
    runner,
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 2,
    pollMs: 10,
    afterRound: afterRoundWith(),
    checks,
    buildOn: (slug) => holder.builds?.holder(slug),
  });
  const planner = new FakeBuildPlanner(options.plan ?? PLAN);
  const readings = [...(options.usage ?? [])];
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => 2,
    ...(options.usage === undefined ? {} : { usage: async () => readings.shift() ?? { kind: 'unavailable' } }),
    usageRetryMs: 60_000,
  });
  holder.builds = builds;
  return { builds, tasks, runner, planner, runs, readings };
}

const start = (plan: PlanOutput = PLAN, overrides: Partial<BuildStartInput> = {}): BuildStartInput => ({
  tasks: plan.tasks,
  limit: plan.tasks.length,
  commands: plan.commands,
  checks: plan.checks,
  fixRounds: 1,
  thresholds: { fiveHour: 80, week: 90 },
  ...overrides,
});

async function planned(s: Setup): Promise<string> {
  const build = await s.builds.plan('garden');
  await s.builds.idle(build.id);
  expect((await s.builds.get(build.id)).state).toBe('planned');
  return build.id;
}

beforeEach(async () => {
  world = await taskWorld('builds-manager');
  project = await world.project('garden', { 'docs/BRIEF.md': BRIEF, 'package.json': JSON.stringify({ scripts: { test: 'node test.js', lint: 'eslint .' } }) });
});
afterEach(() => world.cleanup());

describe('planning a build', () => {
  it('reads the brief, CLAUDE.md and the scripts at the head, and keeps the planner\'s queue as a proposal', async () => {
    const s = setup();
    try {
      const build = await s.builds.plan('garden');
      expect(build.state).toBe('planning');
      expect(await s.builds.holder('garden')).toBe(build.id);
      await s.builds.idle(build.id);
      const view = await s.builds.get(build.id);
      expect(view.state).toBe('planned');
      expect(view.plan).toEqual(PLAN);
      expect(view.tasks).toEqual([]);
      const input = s.planner.runs[0]?.input;
      expect(input?.brief).toBe(BRIEF);
      expect(input?.claudeMd).toBe('# garden\n');
      expect(input?.scripts).toEqual({ test: 'node test.js', lint: 'eslint .' });
      expect(s.planner.runs[0]?.model).toBe('sonnet');
      // The build holds the project: no ordinary task, no second build.
      await expect(s.tasks.start('garden', 'Something.')).rejects.toMatchObject({ code: 'task.buildOnProject' });
      await expect(s.builds.plan('garden')).rejects.toMatchObject({ code: 'build.projectBusy' });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('refuses a project without docs/BRIEF.md, and records a planner that failed', async () => {
    await world.project('orchard');
    const s = setup({ plan: new Error('The planner session ended with error_max_turns.') });
    try {
      await expect(s.builds.plan('orchard')).rejects.toMatchObject({ code: 'build.noBrief' });
      const build = await s.builds.plan('garden');
      await s.builds.idle(build.id);
      const view = await s.builds.get(build.id);
      expect(view.state).toBe('planFailed');
      expect(view.error).toContain('error_max_turns');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

describe('starting a build', () => {
  it('refuses a start that breaks the rules, with every issue', async () => {
    const s = setup();
    try {
      const id = await planned(s);
      const bad = start(PLAN, {
        tasks: [PLAN.tasks[0] as never, { ...PLAN.tasks[1], dependsOn: [2] } as never],
        limit: 3,
        commands: ['npm test', 'npm ci && npm test', 'rm -rf *'],
        checks: ['npm test', 'npm test'],
        fixRounds: 3,
        thresholds: { fiveHour: 0, week: 90 },
      });
      const error = (await s.builds.start(id, bad).catch((failure: unknown) => failure)) as { code: string; params: { issues: string[] } };
      expect(error.code).toBe('build.invalidStart');
      expect(error.params.issues).toEqual([
        'task 2: it may depend only on earlier tasks',
        "how many tasks to run: from 1 to the queue's length",
        'commands line 2: more than one command (list each part on its own)',
        'commands line 3: a wildcard',
        'checks: the same command twice',
        'fix rounds: 0 to 2',
        'usage threshold fiveHour: 1 to 100',
      ]);
      expect((await s.builds.get(id)).state).toBe('planned');
      expect(await integrationHead(project, `briefstack/build-${id}`)).toBeUndefined();
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('runs the queue: a task applied, a failing one fixed once then left waiting, its dependent skipped; the folder untouched', async () => {
    const s = setup();
    try {
      const before = (await gitIn(project, 'rev-parse', 'HEAD')).trim();
      const id = await planned(s);
      const started = await s.builds.start(id, start());
      expect(started.state).toBe('running');
      expect(started.baseCommit).toBe(before);
      expect(started.baseBranch).toBe('main');
      expect(started.settings).toMatchObject({ limit: 3, fixRounds: 1, maxRounds: 6, commands: PLAN.commands, checks: ['npm test'] });
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.state).toBe('finished');
      expect(done.tasks.map((task) => [task.n, task.state, task.reason ?? null, task.rounds])).toEqual([
        [1, 'applied', null, 1],
        [2, 'waiting', 'checksFailed', 2],
        [3, 'skipped', null, 0],
      ]);
      expect(done.tasks[2]?.skippedFor).toBe(2);
      expect(done.roundsRun).toBe(3);
      // Task 1 is the integration branch's one commit; the folder's branch did not move.
      const head = await integrationHead(project, done.branch);
      expect(head).toBe(done.tasks[0]?.commit);
      expect((await gitIn(project, 'show', `${head as string}:LIST.md`)).trim()).toBe('List.');
      expect((await gitIn(project, 'rev-parse', 'HEAD')).trim()).toBe(before);
      expect(await gitIn(project, 'status', '--porcelain')).toBe('');
      // Every round ran unattended; the fix round read what failed.
      expect(s.runner.started.every((round) => round.unattended === true)).toBe(true);
      expect(s.runner.started[2]?.prompt).toContain('This is fix round 2.');
      expect(s.runner.started[2]?.prompt).toContain('FAIL: BROKEN is there');
      // The waiting task is an ordinary task on its own page: open, its proposal kept.
      const waiting = await s.tasks.get(done.tasks[1]?.taskId as string);
      expect(waiting.state).toBe('proposal');
      expect(waiting.build).toEqual({ id, n: 2 });
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });

  it('a denied command leaves the task waiting even when its checks pass; how many tasks to run is kept', async () => {
    const denying: TaskFakeScript = (_round, prompt) => {
      const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'X';
      return { steps: [{ kind: 'shell', command: 'curl https://example.com' }, { kind: 'write', file: `${title}.md`, content: 'x\n' }, { kind: 'end', summary: 'Done.' }] };
    };
    const s = setup({ script: denying });
    try {
      const id = await planned(s);
      await s.builds.start(id, start(PLAN, { limit: 1, fixRounds: 0 }));
      await s.builds.idle(id);
      const done = await s.builds.get(id);
      expect(done.tasks.map((task) => [task.state, task.reason ?? null])).toEqual([
        ['waiting', 'denied'],
        ['queued', null],
        ['queued', null],
      ]);
      expect(done.tasks[0]?.denied).toEqual([{ tool: 'Bash', text: 'curl https://example.com' }]);
      expect(done.state).toBe('finished');
    } finally {
      await s.builds.shutdown();
      await s.tasks.shutdown();
    }
  });
});

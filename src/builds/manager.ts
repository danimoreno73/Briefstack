import { systemPathEnv, type PathEnv } from '../config/paths.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import type { Effort } from '../models.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { checkTaskPreconditions } from '../tasks/preconditions.js';
import type { TaskManager, TaskView } from '../tasks/manager.js';
import { repoState } from '../tasks/git.js';
import { proposalDiff, type ProposalDiff } from '../tasks/proposal.js';
import { newTaskId } from '../tasks/store.js';
import { claudeTokens } from '../tasks/runner.js';
import { isActiveTask, type TaskState } from '../tasks/types.js';
import { redactSecretLines } from '../validate/secrets.js';
import { applyBuild, revertBuild } from './apply.js';
import { approvedListProblems } from './commands.js';
import { commitsSince, createIntegrationBranch, deleteIntegrationBranch, integrationHead } from './git.js';
import { readPlanningInput, type BuildPlanner } from './planner.js';
import { buildRoundPrompt, failureText } from './prompt.js';
import type { BuildStore } from './store.js';
import {
  integrationBranchOf,
  isOpenBuild,
  MAX_BUILD_CHECKS,
  MAX_COMMANDS,
  MAX_FIX_ROUNDS,
  MAX_QUEUE,
  MAX_ROUNDS_CAP,
  queueItemSchema,
  SETTLED_BUILD_STATES,
  type BuildRecord,
  type BuildTask,
  type QueueItem,
  type WaitReason,
} from './types.js';
import { decideUsage, USAGE_RETRY_MS, type UsageReading } from './usage.js';

/**
 * Builds (BRIEF-phase-9): planning a queue from a project's brief, starting
 * it once with the user's rules, and running it task after task through the
 * task manager, unattended, on the build's integration branch. Each task is
 * an ordinary task marked with its build; this manager decides which runs
 * next, runs its checks after each round, applies it when the rules hold,
 * runs fix rounds, and leaves it waiting otherwise.
 */

/** What the start page sends. */
export interface BuildStartInput {
  tasks: QueueItem[];
  limit: number;
  commands: string[];
  checks: string[];
  fixRounds: number;
  thresholds: { fiveHour: number; week: number };
}

export interface BuildManagerOptions {
  store: BuildStore;
  tasks: TaskManager;
  planner: BuildPlanner;
  locations: () => Promise<{ libraryDir: string; repoDir: string }>;
  lang: () => Lang | Promise<Lang>;
  /** The active profile's name and `work` entry: the planner and the tasks use it. */
  profile: () => Promise<{ name: string; model: string; effort: Effort }>;
  /** The plan reading before each task; without it, no pause for usage. */
  usage?: () => Promise<UsageReading>;
  /** The default thresholds for the start page (Settings). */
  thresholds: () => Promise<{ fiveHour: number; week: number }>;
  /** Creations' active sessions, for the shared limit when planning. */
  activeOthers?: () => readonly string[];
  /** The active creation whose folder overlaps a project's, if any. */
  creationOn?: (dir: string) => string | undefined | Promise<string | undefined>;
  /** The task manager's shared limit. */
  maxActive?: () => number | Promise<number>;
  pathEnv?: PathEnv;
  now?: () => Date;
  /** How long to wait to read the usage again when no reset time is known. Default 15 minutes. */
  usageRetryMs?: number;
  /** How long to wait before trying again when the shared limit of active sessions is full. Default 30 seconds. */
  slotRetryMs?: number;
  /** The highest per-build cap on rounds. Default `MAX_ROUNDS_CAP`; tests lower it. */
  roundsCap?: number;
}

/** How long a build waits for a free place in the shared limit before it tries again. */
export const SLOT_RETRY_MS = 30_000;
/** The longest delay `setTimeout` keeps (2^31 - 1 ms); Node runs a longer one at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** What only the server knows of a build while it runs. */
interface Live {
  loop?: Promise<void>;
  /** The user asked to pause: the build pauses before its next task. */
  pausing: boolean;
  cancelling: boolean;
  /** The user resumed: the next task starts without reading the usage. */
  skipUsage: boolean;
  /** The task at work now. */
  taskId?: string;
  timer?: NodeJS.Timeout;
  planAbort?: AbortController;
  planning?: Promise<void>;
  /** The shared limit is full: the build waits for a free place before its next round or checks. */
  waitingSlot?: boolean;
  /** Ends the current wait (for a free place, or for the usage reading) at once: a stop or a cancel. */
  wake?: () => void;
  /** The end of the changes of state queued on the build (`serial`). */
  chain: Promise<unknown>;
}

/** What the build's page shows of a task's own record (M5): its state, checks and Codex calls. */
export interface BuildTaskSummary {
  state: TaskState;
  checks?: { command: string; exitCode: number | null; timedOut: boolean }[];
  /** `delegate_to_codex` calls (only in the user's own rounds on a waiting task: a build's rounds offer no Codex). */
  codexCalls: number;
  /** Codex's tokens as Codex counts them: input without cache, plus output (decisions.md, phase 8, step 28). */
  codexTokens: number;
  /**
   * Claude's own tokens over the task's rounds (decisions.md, "Phase 9: the
   * user's decisions", 2): input and output as the main figure, and with the
   * prompt cache's reads and writes; `rounds` is how many rounds had a
   * reading. Absent when no round has one (rounds before step 33).
   */
  claudeTokens?: { noCache: number; withCache: number; rounds: number };
}

export type BuildTaskView = BuildTask & { task?: BuildTaskSummary };

/** Tasks still open for the user: a worktree and a branch are kept for them. */
const OPEN_TASK_STATES: readonly TaskState[] = ['proposal', 'failed', 'cancelled', 'interrupted'];

export interface BuildView extends Omit<BuildRecord, 'tasks'> {
  tasks: BuildTaskView[];
  pausing?: true;
  cancelling?: true;
  /** The shared limit of active sessions is full: the build waits for a free place. */
  waitingSlot?: true;
}

const clean = (text: string): string => hideAbsolutePaths(redactSecretLines(text)).slice(0, 2000);

export class BuildManager {
  private readonly live = new Map<string, Live>();
  private readonly options: BuildManagerOptions;
  private readonly now: () => Date;
  private readonly pathEnv: PathEnv;
  private stopping = false;
  /** Builds start and plan one at a time, so two cannot take one project. */
  private starting: Promise<unknown> = Promise.resolve();

  constructor(options: BuildManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.pathEnv = options.pathEnv ?? systemPathEnv();
  }

  // ---- reading ----------------------------------------------------------------------------------

  async list(): Promise<BuildView[]> {
    return (await this.options.store.list()).map((record) => this.view(record));
  }

  /** One build, each started task with what its own record says (state, checks, Codex calls). */
  async get(id: string): Promise<BuildView> {
    const record = await this.options.store.load(id);
    if (record === undefined) throw new BriefstackError('build.notFound', { id });
    const view = this.view(record);
    view.tasks = await Promise.all(
      view.tasks.map(async (item): Promise<BuildTaskView> => {
        if (item.taskId === undefined) return item;
        const task = await this.options.tasks.get(item.taskId).catch(() => undefined);
        if (task === undefined) return item;
        const calls = task.rounds.flatMap((round) => round.codex ?? []);
        const readings = task.rounds.flatMap((round) => (round.claude === undefined ? [] : [claudeTokens(round.claude)]));
        const summary: BuildTaskSummary = {
          state: task.state,
          codexCalls: calls.length,
          codexTokens: calls.reduce((sum, call) => sum + (call.usage === undefined ? 0 : Math.max(0, call.usage.input - call.usage.cached) + call.usage.output), 0),
          ...(readings.length === 0
            ? {}
            : { claudeTokens: { noCache: readings.reduce((sum, item) => sum + item.noCache, 0), withCache: readings.reduce((sum, item) => sum + item.withCache, 0), rounds: readings.length } }),
          ...(task.checks === undefined ? {} : { checks: task.checks.map((check) => ({ command: check.command, exitCode: check.exitCode, timedOut: check.timedOut })) }),
        };
        return { ...item, task: summary };
      }),
    );
    return view;
  }

  /** The open build on a project, if any: it holds the project (the task manager asks). */
  async holder(project: string): Promise<string | undefined> {
    return (await this.options.store.list()).find((record) => record.project === project && isOpenBuild(record.state))?.id;
  }

  /** The thresholds the start page offers by default. */
  defaultThresholds(): Promise<{ fiveHour: number; week: number }> {
    return this.options.thresholds();
  }

  private view(record: BuildRecord): BuildView {
    const view: BuildView = structuredClone(record);
    const l = this.live.get(record.id);
    if (l?.pausing === true && record.state === 'running') view.pausing = true;
    if (l?.cancelling === true) view.cancelling = true;
    if (l?.waitingSlot === true && record.state === 'running') view.waitingSlot = true;
    return view;
  }

  // ---- planning and starting --------------------------------------------------------------------

  /** The preconditions of a task on the project, with `except` not counted as holding it. */
  private async preconditions(project: string, except?: string) {
    const { libraryDir, repoDir } = await this.options.locations();
    const limit = (await this.options.maxActive?.()) ?? 2;
    return checkTaskPreconditions(
      {
        libraryDir,
        repoDir,
        pathEnv: this.pathEnv,
        tasks: async () => (await this.options.tasks.list()).filter((task) => task.build?.id === undefined || task.build.id !== except),
        creationOn: (dir) => this.options.creationOn?.(dir),
        active: async () => {
          const ids = [...this.options.tasks.activeIds(), ...(this.options.activeOthers?.() ?? []), ...this.planningIds()];
          return { count: ids.length, limit, ids };
        },
        buildOn: async (slug) => {
          const id = await this.holder(slug);
          return id === except ? undefined : id;
        },
      },
      project,
    );
  }

  /** A task's preconditions for planning, an open task or build on the project said as `build.projectBusy`. */
  private planPreconditions(project: string) {
    return this.preconditions(project).catch((error: unknown) => {
      if (isBriefstackError(error) && (error.code === 'task.projectBusy' || error.code === 'task.buildOnProject')) {
        const params = error.params as { id?: string; build?: string };
        throw new BriefstackError('build.projectBusy', { project, id: params.id ?? params.build ?? '' });
      }
      throw error;
    });
  }

  private planningIds(): string[] {
    return [...this.live.entries()].filter(([, l]) => l.planning !== undefined).map(([id]) => id);
  }

  /** Builds planning now count against the shared limit (a planner is a session). */
  activeIds(): string[] {
    return this.planningIds();
  }

  /**
   * Plans a build: the project's preconditions (as a task's, and no open
   * build or task), its brief at the default branch's head, then the
   * planner session in the background. Returns the new build, `planning`.
   */
  plan(project: string): Promise<BuildView> {
    const run = this.starting.then(() => this.planNow(project));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private async planNow(project: string): Promise<BuildView> {
    this.refuseWhileStopping();
    const start = await this.planPreconditions(project);
    const input = await readPlanningInput(start.dir, start.head, start.slug);
    const profile = await this.options.profile();
    const id = newTaskId(this.now());
    const at = this.now().toISOString();
    const record: BuildRecord = {
      v: 1,
      id,
      project: start.slug,
      projectDir: start.dir,
      state: 'planning',
      profile: profile.name,
      model: profile.model,
      effort: profile.effort,
      createdAt: at,
      updatedAt: at,
      branch: integrationBranchOf(id),
      tasks: [],
      roundsRun: 0,
    };
    await this.options.store.save(record);
    const l = this.liveOf(id);
    const abort = new AbortController();
    l.planAbort = abort;
    const lang = await this.options.lang();
    l.planning = this.options.planner
      .plan({ input, lang, model: profile.model, effort: profile.effort, cwd: this.options.store.planDir(id), signal: abort.signal })
      .then(
        async (plan) => {
          if (this.stopping) return;
          await this.save({ ...record, state: 'planned', plan, updatedAt: this.now().toISOString() });
        },
        async (error: unknown) => {
          if (this.stopping) return;
          await this.save({ ...record, state: 'planFailed', error: await this.message(error), updatedAt: this.now().toISOString() });
        },
      )
      .finally(async () => {
        delete l.planning;
        delete l.planAbort;
        await this.options.store.removePlanDir(id).catch(() => undefined);
      })
      // A failure to save the outcome must not reach the process as an unhandled rejection (review of M3, I6): the
      // record stays `planning`, and the next start's `recover()` closes it.
      .catch(() => undefined);
    return this.view(record);
  }

  /** Whether a build can be planned on the project now, for its page: the first refusal (code and message), or ok. */
  async planInfo(project: string): Promise<{ ok: true } | { ok: false; code: string; params: Readonly<Record<string, unknown>>; message: string }> {
    try {
      const start = await this.planPreconditions(project);
      await readPlanningInput(start.dir, start.head, start.slug);
      return { ok: true };
    } catch (error) {
      if (!isBriefstackError(error)) throw error;
      return { ok: false, code: error.code, params: error.params as Readonly<Record<string, unknown>>, message: formatError(error, await this.options.lang()) };
    }
  }

  /** The issues of a start, or none. */
  startProblems(input: BuildStartInput): string[] {
    const issues: string[] = [];
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) issues.push('the queue is empty');
    if (input.tasks.length > MAX_QUEUE) issues.push(`at most ${MAX_QUEUE} tasks`);
    input.tasks.forEach((task, i) => {
      const parsed = queueItemSchema.safeParse(task);
      if (!parsed.success) issues.push(`task ${i + 1}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(', ')}`);
      else if (parsed.data.dependsOn.some((n) => n >= i + 1)) issues.push(`task ${i + 1}: it may depend only on earlier tasks`);
    });
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > Math.max(1, input.tasks.length)) issues.push('how many tasks to run: from 1 to the queue\'s length');
    issues.push(...approvedListProblems(input.commands, 'commands', MAX_COMMANDS));
    issues.push(...approvedListProblems(input.checks, 'checks', MAX_BUILD_CHECKS));
    if (!Number.isInteger(input.fixRounds) || input.fixRounds < 0 || input.fixRounds > MAX_FIX_ROUNDS) issues.push(`fix rounds: 0 to ${MAX_FIX_ROUNDS}`);
    for (const [name, value] of Object.entries(input.thresholds ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) issues.push(`usage threshold ${name}: 1 to 100`);
    }
    return issues;
  }

  /**
   * Starts a planned build with what the user approved on the start page,
   * all of it recorded and never changed after: the queue, how many tasks,
   * the exact commands, the checks, the fix rounds and the thresholds. The
   * integration branch is made at the default branch's head.
   */
  start(id: string, input: BuildStartInput): Promise<BuildView> {
    const run = this.starting.then(() => this.startNow(id, input));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private async startNow(id: string, input: BuildStartInput): Promise<BuildView> {
    this.refuseWhileStopping();
    const record = await this.load(id);
    if (record.state !== 'planned') throw new BriefstackError('build.wrongState', { id, state: record.state });
    const issues = this.startProblems(input);
    if (issues.length > 0) throw new BriefstackError('build.invalidStart', { issues });
    const start = await this.preconditions(record.project, id);
    await createIntegrationBranch(start.dir, record.branch, start.head);
    const fixRounds = input.fixRounds;
    const tasks: BuildTask[] = input.tasks.map((task, i) => ({
      n: i + 1,
      title: task.title.trim(),
      instruction: task.instruction.trim(),
      doneWhen: task.doneWhen.trim(),
      dependsOn: [...task.dependsOn],
      state: 'queued',
      rounds: 0,
    }));
    const next: BuildRecord = {
      ...record,
      state: 'running',
      baseBranch: start.branch,
      baseCommit: start.head,
      tasks,
      settings: {
        limit: input.limit,
        commands: [...input.commands],
        checks: [...input.checks],
        fixRounds,
        maxRounds: Math.min(this.options.roundsCap ?? MAX_ROUNDS_CAP, tasks.length * (1 + fixRounds)),
        thresholds: { ...input.thresholds },
      },
      startedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    await this.save(next);
    this.kick(id);
    return this.view(next);
  }

  /**
   * Discards a build. One that never started (`planned`, or `planFailed`)
   * has no branch and no task, so the record just becomes `discarded` and
   * the project is free again (review of M3, I4). A settled one loses its
   * open tasks and its integration branch (M5). An applied or reverted one
   * loses only its integration branch (the user's decision, step 33). Runs
   * in the same line as plans and starts, so it cannot pass a start.
   */
  discard(id: string): Promise<BuildView> {
    const run = this.starting.then(() => this.discardNow(id));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private discardNow(id: string): Promise<BuildView> {
    const l = this.liveOf(id);
    return this.serial(l, async () => {
      this.refuseWhileStopping();
      const record = await this.load(id);
      if (record.state === 'planned' || record.state === 'planFailed') {
        const next: BuildRecord = { ...record, state: 'discarded', updatedAt: this.now().toISOString() };
        await this.save(next);
        return this.view(next);
      }
      // An applied or reverted build (decisions.md, "Phase 9: the user's decisions", 1): only its integration branch goes.
      // The commits on the default branch stay, and so does the record, with what it applied and reverted.
      if (record.state === 'applied' || record.state === 'reverted') {
        if ((await repoState(record.projectDir)).branch === record.branch) throw new BriefstackError('build.branchMoved', { branch: record.branch });
        await deleteIntegrationBranch(record.projectDir, record.branch);
        const next: BuildRecord = { ...record, state: 'discarded', updatedAt: this.now().toISOString() };
        await this.save(next);
        return this.view(next);
      }
      // A started build (M5): its open tasks' worktrees and branches go, then its integration branch. Nothing reaches the project.
      this.refuseUnlessSettled(record, l);
      await this.refuseTaskAtWork(record);
      // A branch the user checked out by hand is never removed under their folder (review of M5, minor).
      if ((await repoState(record.projectDir)).branch === record.branch) throw new BriefstackError('build.branchMoved', { branch: record.branch });
      for (const item of record.tasks) {
        if (item.taskId === undefined) continue;
        const task = await this.options.tasks.get(item.taskId).catch(() => undefined);
        if (task !== undefined && OPEN_TASK_STATES.includes(task.state)) await this.options.tasks.discard(item.taskId);
      }
      await deleteIntegrationBranch(record.projectDir, record.branch);
      const next: BuildRecord = { ...record, state: 'discarded', updatedAt: this.now().toISOString() };
      delete next.pause;
      await this.save(next);
      return this.view(next);
    });
  }

  /** Apply, discard: only a build with no loop, no cancel under way, and in a settled state. */
  private refuseUnlessSettled(record: BuildRecord, l: Live): void {
    if (!SETTLED_BUILD_STATES.includes(record.state) || l.loop !== undefined || l.cancelling) throw new BriefstackError('build.wrongState', { id: record.id, state: record.state });
  }

  /** Refused while a task of the build runs a round or checks (the user's own round on a waiting task included). */
  private async refuseTaskAtWork(record: BuildRecord): Promise<void> {
    for (const item of record.tasks) {
      if (item.taskId === undefined) continue;
      const state = this.options.tasks.stateOf(item.taskId) ?? (await this.options.tasks.get(item.taskId).catch(() => undefined))?.state;
      if (state !== undefined && isActiveTask(state)) throw new BriefstackError('build.taskRunning', { id: record.id, task: item.taskId });
    }
  }

  // ---- apply, revert, the diff (M5) -------------------------------------------------------------

  /**
   * Applies the whole build to the project's default branch as one commit
   * (PLAN §1.13), after the user's confirmation on the build's page. Refused
   * while a task of the build works or waits for the user (approve it onto
   * the build's branch, or discard it, first); a task the build cancelled is
   * discarded with it. Nothing is pushed.
   */
  apply(id: string, shownHead: string): Promise<BuildView> {
    const l = this.liveOf(id);
    return this.serial(l, async () => {
      this.refuseWhileStopping();
      const loaded = await this.load(id);
      this.refuseUnlessSettled(loaded, l);
      await this.refuseTaskAtWork(loaded);
      // A waiting task the user approved since (onto the integration branch) counts as applied (review of M5, I1).
      const record: BuildRecord = { ...loaded, tasks: await this.takeInApproved(loaded.tasks) };
      // What lands is the change the page showed, and every commit on the branch since the start is one briefstack made
      // for an applied task: a commit added by hand below a later task's is refused too (review of M5, I2; review of M6, I-1).
      const head = await integrationHead(record.projectDir, record.branch);
      if (head === undefined || head !== shownHead) throw new BriefstackError('build.branchMoved', { branch: record.branch });
      const made = new Set(record.tasks.flatMap((task) => (task.state === 'applied' && task.commit !== undefined ? [task.commit] : [])));
      const since = await commitsSince(record.projectDir, record.baseCommit, head);
      if (since === undefined || since.some((commit) => !made.has(commit))) throw new BriefstackError('build.branchMoved', { branch: record.branch });
      const open: number[] = [];
      const cancelled: string[] = [];
      for (const item of record.tasks) {
        if (item.taskId === undefined) continue;
        const task = await this.options.tasks.get(item.taskId).catch(() => undefined);
        if (task === undefined || !OPEN_TASK_STATES.includes(task.state)) continue;
        if (item.state === 'cancelled') cancelled.push(item.taskId);
        else open.push(item.n);
      }
      if (open.length > 0) throw new BriefstackError('build.openTasks', { id, tasks: open });
      const { libraryDir } = await this.options.locations();
      // The head checked above is what lands, whatever the branch says by then (review of M6, I-1).
      const applied = await applyBuild(record, {
        libraryDir,
        busy: async () => (await this.options.tasks.list()).find((task) => task.project === record.project && isActiveTask(task.state))?.id,
        now: this.now,
        head,
      });
      for (const taskId of cancelled) await this.options.tasks.discard(taskId).catch(() => undefined);
      const next: BuildRecord = { ...record, state: 'applied', applied, updatedAt: this.now().toISOString() };
      delete next.pause;
      delete next.error;
      await this.save(next);
      return this.view(next);
    });
  }

  /** Reverts an applied build with one commit, after the user's confirmation. */
  revert(id: string): Promise<BuildView> {
    const l = this.liveOf(id);
    return this.serial(l, async () => {
      this.refuseWhileStopping();
      const record = await this.load(id);
      if (record.state !== 'applied') throw new BriefstackError('build.wrongState', { id, state: record.state });
      const { libraryDir } = await this.options.locations();
      const reverted = await revertBuild(record, {
        libraryDir,
        busy: async () => (await this.options.tasks.list()).find((task) => task.project === record.project && isActiveTask(task.state))?.id,
        now: this.now,
      });
      const next: BuildRecord = { ...record, state: 'reverted', reverted, updatedAt: this.now().toISOString() };
      await this.save(next);
      return this.view(next);
    });
  }

  /**
   * The whole change on the integration branch since the build's start
   * (BRIEF §3.4): the applied build's commit once applied. `null` before
   * the start, or when the branch is gone (discarded).
   */
  async diff(id: string): Promise<{ diff: ProposalDiff | null; head?: string }> {
    const record = await this.load(id);
    if (record.baseCommit === undefined) return { diff: null };
    if (record.applied !== undefined) return { diff: await proposalDiff(record.projectDir, `${record.applied.commit}^1`, record.applied.commit) };
    const head = await integrationHead(record.projectDir, record.branch);
    if (head === undefined) return { diff: null };
    // `head` is what the page sends back to apply: the change it showed (review of M5, I2).
    return { diff: await proposalDiff(record.projectDir, record.baseCommit, head), head };
  }

  /**
   * A waiting task whose own task the user approved (onto the integration
   * branch) becomes applied, with its commit; so does a task the build
   * cancelled after its round, approved by the user since (review of M6, I-1).
   */
  private async takeInApproved(tasks: readonly BuildTask[]): Promise<BuildTask[]> {
    const out: BuildTask[] = [];
    for (const item of tasks) {
      if ((item.state === 'waiting' || item.state === 'cancelled') && item.taskId !== undefined) {
        const task = await this.options.tasks.get(item.taskId).catch(() => undefined);
        if (task?.state === 'applied') {
          const applied: BuildTask = { ...item, state: 'applied', ...(task.applied === undefined ? {} : { commit: task.applied.commit }) };
          delete applied.reason;
          delete applied.detail;
          out.push(applied);
          continue;
        }
      }
      out.push(item);
    }
    return out;
  }

  // ---- pause, resume, cancel (M4) ---------------------------------------------------------------

  /** Whether a build's loop drives this task now: its round, its checks or its apply (the task manager refuses the user's actions on it). */
  drives(taskId: string): boolean {
    for (const l of this.live.values()) if (l.taskId === taskId) return true;
    return false;
  }

  /**
   * Runs `action` while no other change of the build's state runs: the
   * user's pause, resume, cancel and discard, the timer's resume, and the
   * loop's own changes of state (paused, finished, cancelled). Each action
   * reads the record again when its turn comes (review of M4, I1).
   */
  private serial<T>(l: Live, action: () => Promise<T>): Promise<T> {
    const run = l.chain.then(action);
    l.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * The user's pause: the build pauses before its next task; the task at
   * work goes on to its end. A build paused for usage becomes paused by the
   * user: it no longer resumes by itself.
   */
  pause(id: string): Promise<BuildView> {
    const l = this.liveOf(id);
    return this.serial(l, async () => {
      this.refuseWhileStopping();
      const record = await this.load(id);
      if (record.state === 'paused' && record.pause?.reason !== 'user' && l.loop === undefined && !l.cancelling) {
        if (l.timer !== undefined) clearTimeout(l.timer);
        delete l.timer;
        const next: BuildRecord = { ...record, pause: { reason: 'user', at: this.now().toISOString() }, updatedAt: this.now().toISOString() };
        await this.save(next);
        return this.view(next);
      }
      if (record.state !== 'running' || l.cancelling) throw new BriefstackError('build.wrongState', { id, state: record.state });
      l.pausing = true;
      return this.view(record);
    });
  }

  /**
   * Resumes a paused, interrupted or finished build, on the user's click. A
   * waiting task the user approved since (onto the integration branch) is
   * applied, and the tasks skipped are queued again: those still blocked are
   * skipped again by the loop (PLAN §1.8). The next task starts without
   * reading the plan usage: the user's explicit choice (PLAN §1.9).
   */
  resume(id: string): Promise<BuildView> {
    const run = this.starting.then(() => this.resumeNow(id));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private resumeNow(id: string): Promise<BuildView> {
    const l = this.liveOf(id);
    return this.serial(l, () => this.resumeLocked(id, l));
  }

  private async resumeLocked(id: string, l: Live): Promise<BuildView> {
    this.refuseWhileStopping();
    const record = await this.load(id);
    if (!['paused', 'interrupted', 'finished'].includes(record.state) || l.loop !== undefined || l.cancelling) throw new BriefstackError('build.wrongState', { id, state: record.state });
    const tasks: BuildTask[] = [];
    for (const item of await this.takeInApproved(record.tasks)) {
      // A task that could not start, or met the cap of rounds, has no task of its own to handle: it is queued again
      // (the cap still holds; review of M4, I4).
      if (item.state === 'waiting' && item.taskId === undefined && (item.reason === 'notStarted' || item.reason === 'roundsCap')) {
        const queued: BuildTask = { ...item, state: 'queued' };
        delete queued.reason;
        delete queued.detail;
        tasks.push(queued);
        continue;
      }
      if (item.state === 'skipped') {
        const queued: BuildTask = { ...item, state: 'queued' };
        delete queued.skippedFor;
        tasks.push(queued);
        continue;
      }
      tasks.push(item);
    }
    const next: BuildRecord = { ...record, tasks, state: 'running', updatedAt: this.now().toISOString() };
    delete next.pause;
    delete next.error;
    delete next.finishedAt;
    if (l.timer !== undefined) clearTimeout(l.timer);
    delete l.timer;
    await this.save(next);
    l.pausing = false;
    l.skipUsage = true;
    this.kick(id);
    return this.view(next);
  }

  /**
   * Cancels a build: the round at work is cancelled (the task manager's
   * cancel, which ends its process tree, Codex included) or its checks are
   * ended; a wait for a free place or a usage pause ends. The build becomes
   * `cancelled` once its loop stopped; the integration branch stays.
   */
  cancel(id: string): Promise<BuildView> {
    const l = this.liveOf(id);
    return this.serial(l, async () => {
      this.refuseWhileStopping();
      const record = await this.load(id);
      if ((record.state === 'paused' || record.state === 'interrupted') && l.loop === undefined && !l.cancelling) {
        if (l.timer !== undefined) clearTimeout(l.timer);
        delete l.timer;
        const next: BuildRecord = { ...record, state: 'cancelled', finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
        delete next.pause;
        await this.save(next);
        return this.view(next);
      }
      // A loop at work (running, or just saving its pause): flag it and end what it runs; `finishCancel` records it.
      if (record.state !== 'running' && !(record.state === 'paused' && l.loop !== undefined)) throw new BriefstackError('build.wrongState', { id, state: record.state });
      if (!l.cancelling) {
        l.cancelling = true;
        l.pausing = false;
        if (l.timer !== undefined) clearTimeout(l.timer);
        delete l.timer;
        l.wake?.();
        void this.finishCancel(id, l);
      }
      return this.view(record);
    });
  }

  /** Cancels the task's round, or ends its checks, when the build was asked to cancel. */
  private cancelIfAsked(l: Live, taskId: string): void {
    if (!l.cancelling) return;
    const state = this.options.tasks.stateOf(taskId);
    try {
      if (state === 'running') this.options.tasks.cancel(taskId);
      else if (state === 'checking' && this.options.tasks.checksRunning(taskId)) void this.options.tasks.abortBuildChecks(taskId).catch(() => undefined);
    } catch {
      // It ended meanwhile: nothing to cancel.
    }
  }

  /** Keeps ending what the loop's task runs until the loop stops (a round or checks may start just after the click), then records `cancelled`. */
  private async finishCancel(id: string, l: Live): Promise<void> {
    const loop = l.loop;
    let settled = loop === undefined;
    void loop?.finally(() => (settled = true));
    while (!settled && !this.stopping) {
      if (l.taskId !== undefined) this.cancelIfAsked(l, l.taskId);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await loop?.catch(() => undefined);
    await this.serial(l, async () => {
      try {
        if (this.stopping) return;
        const record = await this.load(id);
        // Running, or paused by the loop just before it saw the cancel: either way the user cancelled it (review of M4, B1).
        if (record.state !== 'running' && record.state !== 'paused') return;
        if (l.timer !== undefined) clearTimeout(l.timer);
        delete l.timer;
        const tasks = record.tasks.map((task) => (task.state === 'running' ? { ...task, state: 'cancelled' as const } : task));
        const next: BuildRecord = { ...record, tasks, state: 'cancelled', finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
        delete next.pause;
        await this.save(next);
      } catch {
        // Nothing more to record.
      } finally {
        l.cancelling = false;
      }
    });
  }

  // ---- the loop ---------------------------------------------------------------------------------

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (l === undefined) {
      l = { pausing: false, cancelling: false, skipUsage: false, chain: Promise.resolve() };
      this.live.set(id, l);
    }
    return l;
  }

  /** Starts the loop of a running build, unless it already runs. */
  private kick(id: string): void {
    const l = this.liveOf(id);
    if (l.loop !== undefined || this.stopping) return;
    l.loop = this.loop(id)
      .catch(async (error: unknown) => {
        // Something the loop did not expect: the build is interrupted, and the task it was at waits (review of M3, I2 and I6).
        try {
          const record = await this.options.store.load(id);
          if (record === undefined || record.state !== 'running' || this.stopping) return;
          const tasks = record.tasks.map((task) => (task.state === 'running' ? { ...task, state: 'waiting' as const, reason: 'interrupted' as const } : task));
          await this.save({ ...record, tasks, state: 'interrupted', error: await this.message(error), updatedAt: this.now().toISOString() });
        } catch {
          // Nothing more to record: the next start's `recover()` closes it.
        }
      })
      .finally(() => {
        delete l.loop;
        delete l.waitingSlot;
      });
  }

  /** Waits `ms`, or less when a stop or a cancel wakes it. */
  private sleep(l: Live, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (l.wake === done) delete l.wake;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      l.wake = done;
    });
  }

  /**
   * Runs one call into the task manager, waiting for a free place while the
   * shared limit of active sessions is full (`task.limit`), so a full limit
   * pauses the queue instead of failing its tasks (review of M3, I2). Gives
   * up, with the error, once a stop or a cancel began.
   */
  private async withSlot<T>(l: Live, call: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        const result = await call();
        delete l.waitingSlot;
        return result;
      } catch (error) {
        if (!isBriefstackError(error) || error.code !== 'task.limit' || this.stopping || l.cancelling) {
          delete l.waitingSlot;
          throw error;
        }
        l.waitingSlot = true;
        await this.sleep(l, this.options.slotRetryMs ?? SLOT_RETRY_MS);
        if (this.stopping || l.cancelling) {
          delete l.waitingSlot;
          throw error;
        }
      }
    }
  }

  private async loop(id: string): Promise<void> {
    const l = this.liveOf(id);
    for (;;) {
      if (this.stopping) return;
      let record = await this.load(id);
      if (record.state !== 'running') return;
      const settings = record.settings;
      if (settings === undefined) return;
      if (l.cancelling) return;
      if (l.pausing) {
        // Under the build's lock, read again: a cancel that came meanwhile wins (review of M4, I1).
        await this.serial(l, async () => {
          const fresh = await this.load(id);
          if (l.cancelling || this.stopping || fresh.state !== 'running') return;
          l.pausing = false;
          await this.save({ ...fresh, state: 'paused', pause: { reason: 'user', at: this.now().toISOString() }, updatedAt: this.now().toISOString() });
        });
        return;
      }
      record = this.skipBlocked(record);
      const started = record.tasks.filter((task) => task.state !== 'queued' && task.state !== 'skipped').length;
      const next = record.tasks.find((task) => task.state === 'queued' && task.dependsOn.every((n) => record.tasks[n - 1]?.state === 'applied'));
      if (next === undefined || started >= settings.limit || record.roundsRun >= settings.maxRounds) {
        const capped = next !== undefined && started < settings.limit;
        const ended = record;
        await this.serial(l, async () => {
          if (l.cancelling || this.stopping) return;
          const base: BuildRecord = { ...ended, state: 'finished', finishedAt: this.now().toISOString() };
          await this.save(capped ? this.withTask(base, (next as BuildTask).n, { state: 'waiting', reason: 'roundsCap' }) : base);
        });
        return;
      }
      // The plan usage before each task, unless the user just resumed it.
      if (l.skipUsage) l.skipUsage = false;
      else if (await this.pausedForUsage(l, record)) return;
      // A pause or a cancel asked during the reading is taken before the task starts (review of M4, B1).
      if (l.cancelling || l.pausing || this.stopping) continue;
      await this.runTask(record, next.n);
    }
  }

  /** Waits for `promise`, or gives `undefined` at once when a stop or a cancel wakes the build. */
  private whileAwake<T>(l: Live, promise: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const done = (value: T | undefined) => {
        if (l.wake === interrupt) delete l.wake;
        resolve(value);
      };
      const interrupt = () => done(undefined);
      l.wake = interrupt;
      if (this.stopping || l.cancelling) interrupt();
      promise.then(done, () => done(undefined));
    });
  }

  /** Marks queued tasks whose dependency did not apply as skipped (directly or not). */
  private skipBlocked(record: BuildRecord): BuildRecord {
    const tasks = record.tasks.map((task) => ({ ...task }));
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (task.state !== 'queued') continue;
        const blocker = task.dependsOn.find((n) => ['waiting', 'skipped', 'cancelled'].includes(tasks[n - 1]?.state ?? ''));
        if (blocker !== undefined) {
          task.state = 'skipped';
          task.skippedFor = blocker;
          changed = true;
        }
      }
    }
    return { ...record, tasks };
  }

  /** Reads the usage; at or above a threshold the build pauses and resumes by itself at the time the reading gives. */
  private async pausedForUsage(l: Live, record: BuildRecord): Promise<boolean> {
    const read = this.options.usage;
    const thresholds = record.settings?.thresholds;
    if (read === undefined || thresholds === undefined) return false;
    // A stop or a cancel does not wait for the reading (review of M4, B1 and I2).
    const reading = await this.whileAwake(l, read().catch((error: unknown): UsageReading => ({ kind: 'failed', message: String(error) })));
    if (reading === undefined) return true;
    const decision = decideUsage(reading, thresholds, this.now(), this.options.usageRetryMs ?? USAGE_RETRY_MS);
    if (decision.go) return false;
    await this.serial(l, async () => {
      const fresh = await this.load(record.id);
      // A cancel or a stop that came during the reading wins: no pause, no timer (review of M4, B1).
      if (l.cancelling || this.stopping || fresh.state !== 'running') return;
      // A pause the user asked during the reading: paused by the user, not resumed by itself.
      if (l.pausing) {
        l.pausing = false;
        await this.save({ ...fresh, state: 'paused', pause: { reason: 'user', at: this.now().toISOString() }, updatedAt: this.now().toISOString() });
        return;
      }
      await this.save({
        ...fresh,
        state: 'paused',
        pause: {
          reason: decision.reason,
          at: this.now().toISOString(),
          until: decision.until.toISOString(),
          ...(decision.fiveHour === undefined ? {} : { fiveHour: decision.fiveHour }),
          ...(decision.sevenDay === undefined ? {} : { sevenDay: decision.sevenDay }),
        },
        updatedAt: this.now().toISOString(),
      });
      this.wakeAt(record.id, decision.until);
    });
    return true;
  }

  /** A paused build resumes by itself at `until` (the usage's reset), while this server runs. */
  private wakeAt(id: string, until: Date): void {
    const l = this.liveOf(id);
    if (l.timer !== undefined) clearTimeout(l.timer);
    // Node runs a longer delay at once (review of M4, I3); `decideUsage` bounds `until` too.
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, until.getTime() - this.now().getTime()));
    l.timer = setTimeout(() => {
      delete l.timer;
      void this.resumeFromPause(id).catch(() => undefined);
    }, delay);
    l.timer.unref();
  }

  private resumeFromPause(id: string): Promise<void> {
    const l = this.liveOf(id);
    return this.serial(l, async () => {
      if (this.stopping || l.cancelling || l.loop !== undefined) return;
      const record = await this.load(id);
      if (record.state !== 'paused' || record.pause?.reason === 'user') return;
      const next: BuildRecord = { ...record, state: 'running', updatedAt: this.now().toISOString() };
      delete next.pause;
      await this.save(next);
      this.kick(id);
    });
  }

  private withTask(record: BuildRecord, n: number, change: Partial<BuildTask>): BuildRecord {
    const tasks = record.tasks.map((task) => (task.n === n ? { ...task, ...change } : task));
    return { ...record, tasks, updatedAt: this.now().toISOString() };
  }

  /** Changes one task of the build on disk, from the record as it is now. */
  private async updateTask(id: string, n: number, change: Partial<BuildTask>, extra: Partial<BuildRecord> = {}): Promise<BuildRecord> {
    const record = await this.load(id);
    const next = { ...this.withTask(record, n, change), ...extra };
    await this.save(next);
    return next;
  }

  /** One task: its first round and fix rounds, its checks after each, then applied to the integration branch or left waiting. */
  private async runTask(record: BuildRecord, n: number): Promise<void> {
    const l = this.liveOf(record.id);
    const settings = record.settings;
    const item = record.tasks[n - 1];
    if (settings === undefined || item === undefined) return;
    const lang = await this.options.lang();
    const denied: { tool: string; text: string }[] = [];
    const round = (fix?: { round: number; failures: string }) => ({
      commands: settings.commands,
      prompt: buildRoundPrompt({ title: item.title, instruction: item.instruction, doneWhen: item.doneWhen, n, total: record.tasks.length, commands: settings.commands, checks: settings.checks, lang, ...(fix === undefined ? {} : { fix }) }),
      onDenied: (entry: { tool: string; text: string }) => denied.push(entry),
    });
    const head = await this.integrationHeadOf(record);
    let task: TaskView;
    try {
      await this.updateTask(record.id, n, { state: 'running' });
      // A cancel that came meanwhile starts no session (review of M4, B1).
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return;
      }
      task = await this.withSlot(l, () =>
        this.options.tasks.startForBuild(record.project, {
          build: { id: record.id, n },
          base: { branch: record.branch, commit: head },
          description: `${item.title}\n\n${item.instruction}\n\nDone when: ${item.doneWhen}`,
          round: round(),
        }),
      );
    } catch (error) {
      // A stop leaves the record as an abrupt stop does, for `recover()` (review of M3, B1).
      if (this.stopping) return;
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return;
      }
      await this.updateTask(record.id, n, { state: 'waiting', reason: 'notStarted', detail: await this.message(error) });
      return;
    }
    l.taskId = task.id;
    // A cancel that came while the task was starting did not know its id: its round is cancelled now.
    this.cancelIfAsked(l, task.id);
    await this.updateTask(record.id, n, { taskId: task.id });
    try {
      let fixesLeft = settings.fixRounds;
      for (;;) {
        task = await this.options.tasks.roundSettled(task.id);
        const counted = await this.load(record.id);
        await this.save({ ...this.withTask(counted, n, { rounds: (counted.tasks[n - 1]?.rounds ?? 0) + 1, denied: [...(counted.tasks[n - 1]?.denied ?? []), ...denied] }), roundsRun: counted.roundsRun + 1 });
        if (this.stopping) return;
        if (l.cancelling) {
          await this.updateTask(record.id, n, { state: 'cancelled' });
          return;
        }
        if (task.state !== 'proposal') {
          await this.updateTask(record.id, n, { state: 'waiting', reason: task.state === 'interrupted' ? 'interrupted' : 'roundFailed', ...(task.error === undefined ? {} : { detail: clean(task.error) }) });
          return;
        }
        if (settings.checks.length > 0) {
          const id = task.id;
          try {
            task = await this.withSlot(l, () => this.options.tasks.runBuildChecks(id, settings.checks));
          } catch (error) {
            if (this.stopping) return;
            await this.updateTask(record.id, n, l.cancelling ? { state: 'cancelled' } : { state: 'waiting', reason: 'roundFailed', detail: await this.message(error) });
            return;
          }
        }
        if (this.stopping) return;
        if (l.cancelling) {
          await this.updateTask(record.id, n, { state: 'cancelled' });
          return;
        }
        if (task.state !== 'proposal') {
          await this.updateTask(record.id, n, { state: 'waiting', reason: 'roundFailed', ...(task.error === undefined ? {} : { detail: clean(task.error) }) });
          return;
        }
        const blocking = (task.validations ?? []).filter((validation) => validation.level === 'error');
        const failed = (task.checks ?? []).filter((check) => check.exitCode !== 0 || check.timedOut);
        const reason: WaitReason | undefined = blocking.length > 0 ? 'blocked' : failed.length > 0 ? 'checksFailed' : denied.length > 0 ? 'denied' : undefined;
        if (reason === undefined) {
          try {
            const applied = await this.options.tasks.applyForBuild(task.id);
            await this.updateTask(record.id, n, { state: 'applied', ...(applied.applied === undefined ? {} : { commit: applied.applied.commit }) });
          } catch (error) {
            if (this.stopping) return;
            await this.updateTask(record.id, n, { state: 'waiting', reason: 'notApplied', detail: await this.message(error) });
          }
          return;
        }
        const now = await this.load(record.id);
        if (fixesLeft <= 0 || now.roundsRun >= settings.maxRounds) {
          await this.updateTask(record.id, n, { state: 'waiting', reason });
          return;
        }
        fixesLeft -= 1;
        const failures = failureText({ checks: task.checks ?? [], denied, validations: task.validations ?? [] });
        denied.length = 0;
        const roundNumber = task.rounds.length + 1;
        const id = task.id;
        try {
          await this.withSlot(l, () => this.options.tasks.newBuildRound(id, `Fix round ${roundNumber}`, round({ round: roundNumber, failures })));
          this.cancelIfAsked(l, id);
        } catch (error) {
          if (this.stopping) return;
          await this.updateTask(record.id, n, l.cancelling ? { state: 'cancelled' } : { state: 'waiting', reason, detail: await this.message(error) });
          return;
        }
      }
    } finally {
      delete l.taskId;
    }
  }

  private async integrationHeadOf(record: BuildRecord): Promise<string> {
    const head = await integrationHead(record.projectDir, record.branch);
    if (head === undefined) throw new BriefstackError('build.branchMoved', { branch: record.branch });
    return head;
  }

  // ---- after a restart --------------------------------------------------------------------------

  /**
   * After a server start: a build the last server left planning, running or
   * paused is interrupted, never resumed by itself; the task it was running
   * (interrupted by the task manager's own recovery) is waiting.
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const record of await this.options.store.list()) {
      if (record.state === 'planning') {
        await this.save({ ...record, state: 'planFailed', error: await this.message(new BriefstackError('build.planStopped', {})), updatedAt: this.now().toISOString() });
        count += 1;
      } else if (record.state === 'running' || record.state === 'paused') {
        const tasks = record.tasks.map((task) => (task.state === 'running' ? { ...task, state: 'waiting' as const, reason: 'interrupted' as const } : task));
        const next: BuildRecord = { ...record, tasks, state: 'interrupted', updatedAt: this.now().toISOString() };
        delete next.pause;
        await this.save(next);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Begins the stop without waiting: nothing new starts, the planners are
   * aborted, the pause timers and the waits for a free place end. The
   * server calls it before the task manager's `shutdown()`, which ends the
   * round or the checks a build's loop waits on; then `shutdown()` waits
   * for the loops (review of M3, B1).
   */
  stop(): void {
    this.stopping = true;
    for (const l of this.live.values()) {
      if (l.timer !== undefined) clearTimeout(l.timer);
      l.planAbort?.abort();
      l.wake?.();
    }
  }

  /** Stops every loop and the planners: what was running is left as an abrupt stop leaves it, for `recover()`. Call the task manager's `shutdown()` between `stop()` and this. */
  async shutdown(): Promise<void> {
    this.stop();
    await Promise.all([...this.live.values()].map(async (l) => {
      await l.planning?.catch(() => undefined);
      await l.loop?.catch(() => undefined);
    }));
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private refuseWhileStopping(): void {
    if (this.stopping) throw new BriefstackError('task.stopping', {});
  }

  private async load(id: string): Promise<BuildRecord> {
    const record = await this.options.store.load(id);
    if (record === undefined) throw new BriefstackError('build.notFound', { id });
    return record;
  }

  private async save(record: BuildRecord): Promise<void> {
    await this.options.store.save({ ...record, updatedAt: this.now().toISOString() });
  }

  private async message(error: unknown): Promise<string> {
    if (isBriefstackError(error)) return clean(formatError(error, await this.options.lang()));
    return clean(error instanceof Error ? error.message : String(error));
  }

  /** For the tests: settles once the build's loop and planner are idle. */
  async idle(id: string): Promise<void> {
    const l = this.live.get(id);
    await l?.planning?.catch(() => undefined);
    await l?.loop?.catch(() => undefined);
  }
}

import { systemPathEnv, type PathEnv } from '../config/paths.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import type { Effort } from '../models.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { checkTaskPreconditions } from '../tasks/preconditions.js';
import type { BuildJoin, TaskManager, TaskView, UnattendedRound } from '../tasks/manager.js';
import type { CheckResult } from '../tasks/types.js';
import { proposalDiff, type ProposalDiff } from '../tasks/proposal.js';
import { newTaskId } from '../tasks/store.js';
import { claudeTokens } from '../tasks/runner.js';
import { isActiveTask, type TaskState } from '../tasks/types.js';
import { redactSecretLines } from '../validate/secrets.js';
import { applyBuild, revertBuild } from './apply.js';
import { approvedListIssues, startIssueText, type StartIssue } from './commands.js';
import { branchCheckedOut, commitsSince, createIntegrationBranch, deleteIntegrationBranch, integrationHead } from './git.js';
import { readPlanningInput, type BuildPlanner } from './planner.js';
import { buildRoundPrompt, failureText } from './prompt.js';
import type { BuildStore } from './store.js';
import {
  capDenied,
  integrationBranchOf,
  isOpenBuild,
  isRevertable,
  MAX_BUILD_CHECKS,
  MAX_COMMANDS,
  MAX_FIX_ROUNDS,
  MAX_QUEUE,
  MAX_ROUNDS_CAP,
  MAX_SLOTS,
  MAX_AUTO_RESUMES,
  areaProblem,
  areasOverlap,
  type JoinFailure,
  CARD_SIZES,
  queueItemSchema,
  SETTLED_BUILD_STATES,
  type BuildRecord,
  type BuildTask,
  type QueueItem,
  type WaitReason,
} from './types.js';
import { decideUsage, USAGE_RETRY_MS, type UsageReading } from './usage.js';
import type { ReserveProvider } from '../providers/config.js';
import { readProviderKey } from '../providers/env.js';

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
  /** The user confirmed a start with no checks (every task with no denied command is then applied). */
  noChecks?: boolean;
  /** How many cards run at once (phase 11), 1 to `MAX_SLOTS`; one when absent, as in phase 9. */
  slots?: number;
  /** At the usage threshold, go on with this reserve provider (phase 12); absent: pause, as before. */
  reserve?: string;
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
  /** The reserve providers of `config.json` (phase 12), read when a build starts and at each threshold; none without it. */
  providers?: () => Promise<readonly ReserveProvider[]>;
  /** The most cards a build runs at once on this machine (phase 12), read at each pass; `MAX_SLOTS` without it. */
  slotsCap?: () => Promise<number>;
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
  /** The cards at work now, by their number (phase 11: one with one slot). */
  running: Map<number, RunningCard>;
  timer?: NodeJS.Timeout;
  planAbort?: AbortController;
  planning?: Promise<void>;
  /** The cards waiting for a free place in the shared limit before their next round, checks or join. */
  waitingSlots: Set<number>;
  /** End the current waits (for a free place, for the usage reading, for a card) at once: a stop or a cancel. */
  wakers: Set<() => void>;
  /** The end of the changes of state queued on the build (`serial`). */
  chain: Promise<unknown>;
  /** The end of the changes of the record queued by the cards and the loop (`edit`): load, change, save, in turn. */
  edits: Promise<unknown>;
  /** The end of the joins queued on the build: one join at a time (BRIEF-phase-11 §2, 9). */
  joins: Promise<unknown>;
  /** Something a card did not expect: no card starts, and the loop fails once none is at work. */
  failure?: { error: unknown };
}

/** A card at work (phase 11). */
interface RunningCard {
  n: number;
  area: readonly string[] | undefined;
  /** Its task, once started. */
  taskId?: string;
  /** Settles when the card's work ended (never rejects). */
  done: Promise<void>;
}

/** How many times a join is tried again when the integration head moved between its read and the compare and swap. */
const JOIN_TRIES = 3;

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
    if (l !== undefined && l.waitingSlots.size > 0 && record.state === 'running') view.waitingSlot = true;
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

  /** The issues of a start, each a code the page translates (step 33), or none. */
  startIssues(input: BuildStartInput): StartIssue[] {
    const issues: StartIssue[] = [];
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) issues.push({ key: 'emptyQueue' });
    if (input.tasks.length > MAX_QUEUE) issues.push({ key: 'tooManyTasks', max: MAX_QUEUE });
    input.tasks.forEach((item, i) => {
      // A card's area and size each have their own issue, which says what is wrong (review of M1, I1); the other
      // fields are read as phase 9 read them.
      let task: unknown = item;
      if (typeof item === 'object' && item !== null) {
        const { area, size, ...rest } = item as QueueItem;
        const problem = area === undefined ? undefined : areaProblem(area);
        if (problem !== undefined) issues.push({ key: 'areaInvalid', n: i + 1, problem });
        if (size !== undefined && !(CARD_SIZES as readonly unknown[]).includes(size)) issues.push({ key: 'sizeInvalid', n: i + 1 });
        task = { ...rest, ...(area === undefined || problem !== undefined ? {} : { area }) };
      }
      const parsed = queueItemSchema.safeParse(task);
      if (!parsed.success) {
        issues.push({
          key: 'taskInvalid',
          n: i + 1,
          fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')).filter((field) => field !== ''))],
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(', '),
        });
      } else if (parsed.data.dependsOn.some((n) => n >= i + 1)) issues.push({ key: 'laterDependency', n: i + 1 });
    });
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > Math.max(1, input.tasks.length)) issues.push({ key: 'limit' });
    issues.push(...approvedListIssues(input.commands, 'commands', MAX_COMMANDS));
    issues.push(...approvedListIssues(input.checks, 'checks', MAX_BUILD_CHECKS));
    if (!Number.isInteger(input.fixRounds) || input.fixRounds < 0 || input.fixRounds > MAX_FIX_ROUNDS) issues.push({ key: 'fixRounds', max: MAX_FIX_ROUNDS });
    if (input.slots !== undefined && (!Number.isInteger(input.slots) || input.slots < 1 || input.slots > MAX_SLOTS)) issues.push({ key: 'slots', max: MAX_SLOTS });
    for (const [name, value] of Object.entries(input.thresholds ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) issues.push({ key: 'threshold', name });
    }
    // With no checks, "the checks pass" holds by itself: every task with no denied command is applied. The user says
    // so explicitly (review of M3, minor; step 33).
    if (Array.isArray(input.checks) && input.checks.length === 0 && input.noChecks !== true) issues.push({ key: 'noChecks' });
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
    const items = this.startIssues(input);
    if (items.length > 0) throw new BriefstackError('build.invalidStart', { issues: items.map(startIssueText), items });
    // A reserve must be one of config.json's providers now; it is looked up again by name at each threshold.
    if (input.reserve !== undefined && !((await this.options.providers?.()) ?? []).some((provider) => provider.name === input.reserve)) {
      throw new BriefstackError('build.reserveUnknown', { name: input.reserve });
    }
    const start = await this.preconditions(record.project, id);
    await createIntegrationBranch(start.dir, record.branch, start.head);
    const fixRounds = input.fixRounds;
    const tasks: BuildTask[] = input.tasks.map((task, i) => ({
      n: i + 1,
      title: task.title.trim(),
      instruction: task.instruction.trim(),
      doneWhen: task.doneWhen.trim(),
      dependsOn: [...task.dependsOn],
      ...(task.area === undefined ? {} : { area: task.area.map((item) => item.trim()) }),
      ...(task.size === undefined ? {} : { size: task.size }),
      state: 'queued',
      rounds: 0,
    }));
    const slots = input.slots ?? 1;
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
        // With more than one slot each card may be redone once after a conflict (phase 11): twice the rounds, same cap.
        maxRounds: Math.min(this.options.roundsCap ?? MAX_ROUNDS_CAP, tasks.length * (1 + fixRounds) * (slots > 1 ? 2 : 1)),
        thresholds: { ...input.thresholds },
        ...(input.slots === undefined ? {} : { slots }),
        ...(input.reserve === undefined ? {} : { reserve: input.reserve }),
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
        // `deleteIntegrationBranch` refuses a branch any worktree has checked out (step 33).
        await deleteIntegrationBranch(record.projectDir, record.branch);
        const next: BuildRecord = { ...record, state: 'discarded', updatedAt: this.now().toISOString() };
        await this.save(next);
        return this.view(next);
      }
      // A started build (M5): its open tasks' worktrees and branches go, then its integration branch. Nothing reaches the project.
      this.refuseUnlessSettled(record, l);
      await this.refuseTaskAtWork(record);
      // A branch the user checked out by hand, in the project folder or another worktree, is never removed under it, and
      // nothing else is discarded first (review of M5 and of M1, minor; step 33).
      if (await branchCheckedOut(record.projectDir, record.branch)) throw new BriefstackError('build.branchCheckedOut', { branch: record.branch });
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
      // A discarded build that was applied can still be reverted: discarding deleted only its branch (review of step 33, A, I-1).
      if (!isRevertable(record)) throw new BriefstackError('build.wrongState', { id, state: record.state });
      const { libraryDir } = await this.options.locations();
      const reverted = await revertBuild(record, {
        libraryDir,
        busy: async () => (await this.options.tasks.list()).find((task) => task.project === record.project && isActiveTask(task.state))?.id,
        now: this.now,
      });
      // A discarded build stays discarded (its branch is gone), with the revert recorded.
      const next: BuildRecord = { ...record, state: record.state === 'discarded' ? 'discarded' : 'reverted', reverted, updatedAt: this.now().toISOString() };
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
    for (const l of this.live.values()) for (const card of l.running.values()) if (card.taskId === taskId) return true;
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

  /**
   * `auto`: the server resumes it by itself after a restart (phase 12):
   * nobody is there to take up a card the restart interrupted, so it starts
   * again at the integration head whatever the slots, and the plan usage is
   * read before the next cards, as any pass does.
   */
  private async resumeLocked(id: string, l: Live, auto = false): Promise<BuildView> {
    this.refuseWhileStopping();
    const record = await this.load(id);
    if (!['paused', 'interrupted', 'finished'].includes(record.state) || l.loop !== undefined || l.cancelling) throw new BriefstackError('build.wrongState', { id, state: record.state });
    // A cancel mark left by a failed save is stale once the user resumes (review of step 33, B, M1).
    await this.options.store.clearCancel(id);
    const tasks: BuildTask[] = [];
    let givenBack = 0;
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
      // With more than one slot, a card a server stop interrupted starts again at the integration head, its task
      // discarded (BRIEF-phase-11 §3). With one slot it waits for the user, as in phase 9 (decisions.md, "Decisiones sin
      // Dani (fase 11)").
      // Only a card whose task the stop left interrupted: one the user took up since (a round of their own, a proposal)
      // stays theirs (review of M3, I3).
      if ((auto || (record.settings?.slots ?? 1) > 1) && item.state === 'waiting' && item.reason === 'interrupted') {
        const task = item.taskId === undefined ? undefined : await this.options.tasks.get(item.taskId).catch(() => undefined);
        if (item.taskId === undefined || task === undefined || task.state === 'interrupted') {
          if (item.taskId !== undefined && task?.state === 'interrupted') await this.options.tasks.discard(item.taskId);
          const queued: BuildTask = { ...item, state: 'queued' };
          delete queued.reason;
          delete queued.detail;
          delete queued.taskId;
          // Its last join belonged to the discarded attempt; a redo it already had still counts (review of M3, minor 8).
          delete queued.join;
          // Resumed by itself (phase 12): the round the restart cut short does not count against the cap of rounds,
          // or a restart would eat a card's round; restarts in a row are bounded by `MAX_AUTO_RESUMES` instead.
          if (auto && item.taskId !== undefined) givenBack += 1;
          tasks.push(queued);
          continue;
        }
      }
      tasks.push(item);
    }
    const next: BuildRecord = { ...record, tasks, state: 'running', roundsRun: Math.max(0, record.roundsRun - givenBack), updatedAt: this.now().toISOString() };
    delete next.pause;
    delete next.error;
    delete next.finishedAt;
    delete next.restart;
    // Resumed by itself: one more in a row (reset when a card ends). Resumed by the user: the count starts again.
    if (auto) next.autoResumes = (record.autoResumes ?? 0) + 1;
    else {
      delete next.autoResumes;
      delete next.autoResumeStopped;
    }
    if (l.timer !== undefined) clearTimeout(l.timer);
    delete l.timer;
    await this.save(next);
    l.pausing = false;
    l.skipUsage = !auto;
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
        // On disk at once, in a file of its own: a server stop before the loop records the cancel leaves the build
        // cancelled (step 33). Never through `build.json`, which the loop writes meanwhile (review of step 33, B, I1).
        await this.options.store.markCancel(id, this.now().toISOString()).catch(() => undefined);
        this.wakeAll(l);
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

  /**
   * Keeps ending what every running card's task runs until the loop stops
   * (a round or checks may start just after the click; phase 11: every
   * card's tree), then records `cancelled`.
   */
  private async finishCancel(id: string, l: Live): Promise<void> {
    const loop = l.loop;
    let settled = loop === undefined;
    void loop?.finally(() => (settled = true));
    while (!settled && !this.stopping) {
      for (const card of l.running.values()) if (card.taskId !== undefined) this.cancelIfAsked(l, card.taskId);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await loop?.catch(() => undefined);
    await this.serial(l, async () => {
      try {
        if (this.stopping) return;
        const record = await this.load(id);
        // Running, or paused by the loop just before it saw the cancel: either way the user cancelled it (review of M4, B1).
        if (record.state === 'running' || record.state === 'paused') {
          if (l.timer !== undefined) clearTimeout(l.timer);
          delete l.timer;
          await this.save(this.cancelledNow(record));
        }
        // Recorded (or the build had already left those states): the mark is no longer needed. Kept when the save failed.
        await this.options.store.clearCancel(id);
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
      l = { pausing: false, cancelling: false, skipUsage: false, running: new Map(), waitingSlots: new Set(), wakers: new Set(), chain: Promise.resolve(), edits: Promise.resolve(), joins: Promise.resolve() };
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
          // A loop that failed while the user cancelled: the build is cancelled, not interrupted (step 33).
          if (l.cancelling || (await this.options.store.cancelMarked(id))) {
            await this.save({ ...this.cancelledNow(record), error: await this.message(error) });
            await this.options.store.clearCancel(id);
            return;
          }
          const tasks = record.tasks.map((task) => (task.state === 'running' ? { ...task, state: 'waiting' as const, reason: 'interrupted' as const } : task));
          await this.save({ ...record, tasks, state: 'interrupted', error: await this.message(error), updatedAt: this.now().toISOString() });
        } catch {
          // Nothing more to record: the next start's `recover()` closes it.
        }
      })
      .finally(() => {
        delete l.loop;
        delete l.failure;
        l.waitingSlots.clear();
      });
  }

  /** Ends every wait of the build at once: a stop or a cancel. */
  private wakeAll(l: Live): void {
    for (const wake of [...l.wakers]) wake();
  }

  /** Waits `ms`, or less when a stop or a cancel wakes it. */
  private sleep(l: Live, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        l.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      l.wakers.add(done);
    });
  }

  /**
   * Runs one call into the task manager, waiting for a free place while the
   * shared limit of active sessions is full (`task.limit`), so a full limit
   * pauses the card instead of failing it (review of M3, I2). Gives up, with
   * the error, once a stop or a cancel began.
   */
  private async withSlot<T>(l: Live, n: number, call: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        const result = await call();
        l.waitingSlots.delete(n);
        return result;
      } catch (error) {
        if (!isBriefstackError(error) || error.code !== 'task.limit' || this.stopping || l.cancelling) {
          l.waitingSlots.delete(n);
          throw error;
        }
        l.waitingSlots.add(n);
        await this.sleep(l, this.options.slotRetryMs ?? SLOT_RETRY_MS);
        if (this.stopping || l.cancelling) {
          l.waitingSlots.delete(n);
          throw error;
        }
      }
    }
  }

  /**
   * The scheduler (BRIEF-phase-11 §3; PLAN-phase-11 §1, 10 and 11). Each
   * pass starts, while a slot is free, the first queued card in priority
   * order whose dependencies are applied and whose area overlaps no running
   * card's, under "how many to run" and the cap of rounds, after one reading
   * of the plan usage; then waits for a card to end. With one slot this is
   * phase 9's loop: one task, its end, the next. A pause, the usage over its
   * threshold, a cancel or a stop start nothing more; the loop ends once no
   * card is at work.
   */
  private async loop(id: string): Promise<void> {
    const l = this.liveOf(id);
    for (;;) {
      if (this.stopping || l.cancelling || l.failure !== undefined) {
        await this.drain(l);
        if (l.failure !== undefined) throw l.failure.error;
        return;
      }
      let outcome: 'again' | 'stop';
      try {
        outcome = await this.pass(l, id);
      } catch (error) {
        // A pass that fails while cards are at work does not leave them behind: no card starts, and the loop fails
        // once none is at work (review of M3, I2).
        if (l.running.size === 0) throw error;
        l.failure ??= { error };
        outcome = 'again';
      }
      if (outcome === 'stop') return;
    }
  }

  /** One pass of the loop: `stop` when the loop ends (paused, finished, no longer running), `again` otherwise. */
  private async pass(l: Live, id: string): Promise<'again' | 'stop'> {
    let record = await this.load(id);
    if (record.state !== 'running' || record.settings === undefined) {
      await this.drain(l);
      return 'stop';
    }
    const settings = record.settings;
    if (l.pausing) {
      // The cards at work go on to their end; the build pauses once none is (phase 11).
      if (l.running.size > 0) {
        await this.anyCardEnd(l);
        return 'again';
      }
      // Under the build's lock, read again: a cancel that came meanwhile wins (review of M4, I1).
      await this.serial(l, async () => {
        const fresh = await this.load(id);
        if (l.cancelling || this.stopping || fresh.state !== 'running') return;
        l.pausing = false;
        await this.save({ ...fresh, state: 'paused', pause: { reason: 'user', at: this.now().toISOString() }, updatedAt: this.now().toISOString() });
      });
      return 'stop';
    }
    if (this.skipBlocked(record).tasks.some((task, i) => task.state !== record.tasks[i]?.state)) record = await this.edit(l, id, (fresh) => this.skipBlocked(fresh));
    const started = record.tasks.filter((task) => task.state !== 'queued' && task.state !== 'skipped').length;
    const next = record.tasks.find((task) => task.state === 'queued' && task.dependsOn.every((n) => record.tasks[n - 1]?.state === 'applied'));
    const canStart = next !== undefined && started < settings.limit && record.roundsRun < settings.maxRounds;
    if (l.running.size === 0 && !canStart) {
      // Read again behind every change a card asked for: a card that ended while this pass read the record has saved
      // its outcome by now, and may let another card start (review of M3, B1). No card runs, so nothing writes after.
      const finished = await this.serial(l, async () => {
        if (l.cancelling || this.stopping) return true;
        await l.edits;
        const fresh = this.skipBlocked(await this.load(id));
        const freshStarted = fresh.tasks.filter((task) => task.state !== 'queued' && task.state !== 'skipped').length;
        const freshNext = fresh.tasks.find((task) => task.state === 'queued' && task.dependsOn.every((n) => fresh.tasks[n - 1]?.state === 'applied'));
        if (freshNext !== undefined && freshStarted < settings.limit && fresh.roundsRun < settings.maxRounds) return false;
        const capped = freshNext !== undefined && freshStarted < settings.limit;
        const base: BuildRecord = { ...fresh, state: 'finished', finishedAt: this.now().toISOString() };
        await this.save(capped ? this.withTask(base, (freshNext as BuildTask).n, { state: 'waiting', reason: 'roundsCap' }) : base);
        return true;
      });
      return finished ? 'stop' : 'again';
    }
    // The machine's cap on slots (phase 12) bounds the build's own, read at each pass so a change in Settings counts.
    const slots = Math.min(settings.slots ?? 1, await this.slotsCapNow());
    const batch = canStart ? this.readyCards(record, l, slots, settings.limit - started) : [];
    if (batch.length === 0) {
      await this.anyCardEnd(l);
      return 'again';
    }
    // The plan usage before the cards of this pass start, unless the user just resumed it (H0, 5).
    let provider: ReserveProvider | undefined;
    if (l.skipUsage) l.skipUsage = false;
    else {
      const gate = await this.usageGate(l, record);
      if (gate === 'paused') return 'stop';
      if (gate === 'wait') {
        await this.anyCardEnd(l);
        return 'again';
      }
      if (gate === 'woken') return 'again';
      // Over the threshold with a reserve: this pass's cards start on it (phase 12).
      if (typeof gate === 'object') provider = gate.reserve;
    }
    // A pause or a cancel asked during the reading is taken before a card starts (review of M4, B1).
    if (l.cancelling || l.pausing || this.stopping) return 'again';
    for (const card of batch) this.launch(l, record, card, provider);
    return 'again';
  }

  /**
   * The cards a pass may start: queued, their dependencies applied, in the
   * order of the board, each area overlapping no running card's nor one
   * started before it in the pass (BRIEF-phase-11 §2, 4), while slots are
   * free and under how many may still start.
   */
  private readyCards(record: BuildRecord, l: Live, slots: number, left: number): BuildTask[] {
    const busy: (readonly string[] | undefined)[] = [...l.running.values()].map((card) => card.area);
    const out: BuildTask[] = [];
    for (const task of record.tasks) {
      if (out.length >= Math.min(slots - l.running.size, left)) break;
      if (task.state !== 'queued' || l.running.has(task.n)) continue;
      if (!task.dependsOn.every((n) => record.tasks[n - 1]?.state === 'applied')) continue;
      if (busy.some((area) => areasOverlap(area, task.area))) continue;
      busy.push(task.area);
      out.push(task);
    }
    return out;
  }

  /** Starts a card's work without waiting for it; it is in `running` before any await. */
  private launch(l: Live, record: BuildRecord, task: BuildTask, provider?: ReserveProvider): void {
    const card: RunningCard = { n: task.n, area: task.area, done: Promise.resolve() };
    l.running.set(task.n, card);
    card.done = this.runCard(record, task.n, card, provider)
      .catch((error: unknown) => {
        // A card that failed in a way the loop did not expect: nothing more starts, and the loop fails once no card is at work.
        l.failure ??= { error };
      })
      .finally(() => {
        l.running.delete(task.n);
        l.waitingSlots.delete(task.n);
      });
  }

  /** Waits until a running card ends, or a stop or a cancel wakes the build. */
  private async anyCardEnd(l: Live): Promise<void> {
    if (l.running.size === 0) return;
    await this.whileAwake(l, Promise.race([...l.running.values()].map((card) => card.done)));
  }

  /** Waits until no card is at work (a stop or a cancel ends their rounds and checks). */
  private async drain(l: Live): Promise<void> {
    while (l.running.size > 0) await Promise.all([...l.running.values()].map((card) => card.done));
  }

  /** Waits for `promise`, or gives `undefined` at once when a stop or a cancel wakes the build. */
  private whileAwake<T>(l: Live, promise: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const done = (value: T | undefined) => {
        l.wakers.delete(interrupt);
        resolve(value);
      };
      const interrupt = () => done(undefined);
      l.wakers.add(interrupt);
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

  /**
   * Reads the usage before the cards of a pass start: `go`; `woken` when a
   * stop or a cancel ended the reading; at or above a threshold, `wait`
   * while cards are at work (they go on; a reading is made again when one
   * ends and another could start), else `paused`: the build pauses and
   * resumes by itself at the time the reading gives (BRIEF-phase-11 §2, 6).
   */
  private async usageGate(l: Live, record: BuildRecord): Promise<'go' | 'woken' | 'wait' | 'paused' | { reserve: ReserveProvider }> {
    const read = this.options.usage;
    const thresholds = record.settings?.thresholds;
    if (read === undefined || thresholds === undefined) return 'go';
    // A stop or a cancel does not wait for the reading (review of M4, B1 and I2).
    const reading = await this.whileAwake(l, read().catch((error: unknown): UsageReading => ({ kind: 'failed', message: String(error) })));
    if (reading === undefined) return 'woken';
    const decision = decideUsage(reading, thresholds, this.now(), this.options.usageRetryMs ?? USAGE_RETRY_MS);
    if (decision.go) return 'go';
    // Phase 12 (PLAN-phase-12 §1, 11): over a threshold, a build started with a reserve goes on with it, when its key
    // file is there now. A failed reading still pauses: unknown is not "over".
    let reserveMissing: string | undefined;
    const reserveName = record.settings?.reserve;
    if (decision.reason === 'usage' && reserveName !== undefined) {
      const provider = ((await this.options.providers?.().catch(() => [])) ?? []).find((entry) => entry.name === reserveName);
      // The same rule as the round's (review of M4, 5): a key file the round would refuse pauses the build here
      // instead of failing its cards. The key read is dropped at once; the round reads it again when it starts.
      if (provider !== undefined && (await readProviderKey(provider).then(() => true, () => false))) return { reserve: provider };
      reserveMissing = reserveName;
    }
    if (l.running.size > 0) return 'wait';
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
          ...(reserveMissing === undefined ? {} : { reserveMissing }),
        },
        updatedAt: this.now().toISOString(),
      });
      this.wakeAt(record.id, decision.until);
    });
    return 'paused';
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
    const next: BuildRecord = { ...record, tasks, updatedAt: this.now().toISOString() };
    // A card that ended (applied, or left waiting) ends the run of restarts in a row (phase 12).
    if (change.state === 'applied' || change.state === 'waiting') delete next.autoResumes;
    return next;
  }

  /** Changes the record, from what it is on disk now, behind every other change the cards and the loop asked for (H0, 1). */
  private edit(l: Live, id: string, change: (record: BuildRecord) => BuildRecord): Promise<BuildRecord> {
    const run = l.edits.then(async () => {
      const next = change(await this.load(id));
      await this.save(next);
      return next;
    });
    l.edits = run.catch(() => undefined);
    return run;
  }

  /** Changes one task of the build on disk, from the record as it is now. */
  private updateTask(id: string, n: number, change: Partial<BuildTask>, extra: Partial<BuildRecord> = {}): Promise<BuildRecord> {
    return this.edit(this.liveOf(id), id, (record) => ({ ...this.withTask(record, n, change), ...extra }));
  }

  /**
   * One card (phase 9's task): its first round and fix rounds, its checks
   * after each, then its join onto the integration branch (phase 11), or
   * left waiting. A join that conflicts, or whose checks fail on the joined
   * commit, redoes the card once at the integration head; a second time it
   * waits for the user (BRIEF-phase-11 §2, 4 and 9).
   */
  private async runCard(record: BuildRecord, n: number, card: RunningCard, provider?: ReserveProvider): Promise<void> {
    const l = this.liveOf(record.id);
    const settings = record.settings;
    const item = record.tasks[n - 1];
    if (settings === undefined || item === undefined) return;
    const lang = await this.options.lang();
    const denied: { tool: string; text: string }[] = [];
    // A card started again after a restart keeps the redo it already had: its prompt still says so (review of M3, minor 8).
    let redo: JoinFailure | undefined = item.redo?.reason;
    const round =(fix?: { round: number; failures: string }) => ({
      commands: settings.commands,
      prompt: buildRoundPrompt({
        title: item.title,
        instruction: item.instruction,
        doneWhen: item.doneWhen,
        n,
        total: record.tasks.length,
        commands: settings.commands,
        checks: settings.checks,
        lang,
        ...(fix === undefined ? {} : { fix }),
        ...(redo === undefined ? {} : { redo }),
      }),
      onDenied: (entry: { tool: string; text: string }) => denied.push(entry),
      // A card keeps the provider it started on for all its rounds, its fix rounds and its redo (phase 12).
      ...(provider === undefined ? {} : { provider }),
    });
    for (;;) {
      const outcome = await this.attempt(record, n, card, round, denied, provider?.name);
      if (outcome === 'done') return;
      // The join failed: the one redo, at the integration head, with a fresh task (the first one discarded).
      const previous = card.taskId as string;
      if (this.stopping) return;
      // A cancel that came during the join: nothing is redone, nothing discarded (review of M3, minor 9).
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return;
      }
      const now = await this.load(record.id);
      if (redo !== undefined || now.tasks[n - 1]?.redo !== undefined || now.roundsRun >= settings.maxRounds) {
        await this.updateTask(record.id, n, { state: 'waiting', reason: outcome === 'conflict' ? 'conflict' : 'joinChecksFailed' });
        return;
      }
      redo = outcome;
      try {
        await this.options.tasks.discardForBuild(previous);
      } catch (error) {
        if (this.stopping) return;
        await this.updateTask(record.id, n, { state: 'waiting', reason: outcome === 'conflict' ? 'conflict' : 'joinChecksFailed', detail: await this.message(error) });
        return;
      }
      delete card.taskId;
      denied.length = 0;
      await this.edit(l, record.id, (fresh) => {
        const next = this.withTask(fresh, n, { redo: { reason: outcome, previousTask: previous } });
        const task = next.tasks[n - 1];
        if (task !== undefined) delete task.taskId;
        return next;
      });
    }
  }

  /**
   * One attempt of a card: a task at the integration head, its rounds and
   * checks, then its join. `done` when the card was applied, left waiting or
   * cancelled (or a stop came); otherwise why its join failed.
   */
  private async attempt(
    record: BuildRecord,
    n: number,
    card: RunningCard,
    round: (fix?: { round: number; failures: string }) => UnattendedRound,
    denied: { tool: string; text: string }[],
    /** The reserve provider of this attempt (phase 12); absent: Claude. */
    providerName?: string,
  ): Promise<'done' | JoinFailure> {
    const l = this.liveOf(record.id);
    const settings = record.settings as NonNullable<BuildRecord['settings']>;
    const item = record.tasks[n - 1] as BuildTask;
    let task: TaskView;
    try {
      const head = await this.integrationHeadOf(record);
      // The card shows the provider of its current attempt; one started again on Claude loses an earlier one.
      await this.edit(l, record.id, (fresh) => {
        const next = this.withTask(fresh, n, { state: 'running', ...(providerName === undefined ? {} : { provider: providerName }) });
        if (providerName === undefined) delete next.tasks[n - 1]?.provider;
        return next;
      });
      // A cancel that came meanwhile starts no session (review of M4, B1).
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return 'done';
      }
      task = await this.withSlot(l, n, () =>
        this.options.tasks.startForBuild(record.project, {
          build: { id: record.id, n },
          base: { branch: record.branch, commit: head },
          description: `${item.title}\n\n${item.instruction}\n\nDone when: ${item.doneWhen}`,
          round: round(),
        }),
      );
    } catch (error) {
      // A stop leaves the record as an abrupt stop does, for `recover()` (review of M3, B1).
      if (this.stopping) return 'done';
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return 'done';
      }
      await this.updateTask(record.id, n, { state: 'waiting', reason: 'notStarted', detail: await this.message(error) });
      return 'done';
    }
    card.taskId = task.id;
    // A cancel that came while the task was starting did not know its id: its round is cancelled now.
    this.cancelIfAsked(l, task.id);
    await this.updateTask(record.id, n, { taskId: task.id });
    let fixesLeft = settings.fixRounds;
    for (;;) {
      task = await this.options.tasks.roundSettled(task.id);
      const kept = [...denied];
      await this.edit(l, record.id, (counted) => {
        const before = counted.tasks[n - 1];
        const capped = capDenied(before?.denied ?? [], before?.deniedOmitted ?? 0, kept);
        return { ...this.withTask(counted, n, { rounds: (before?.rounds ?? 0) + 1, denied: capped.denied, ...(capped.deniedOmitted > 0 ? { deniedOmitted: capped.deniedOmitted } : {}) }), roundsRun: counted.roundsRun + 1 };
      });
      if (this.stopping) return 'done';
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return 'done';
      }
      if (task.state !== 'proposal') {
        await this.updateTask(record.id, n, { state: 'waiting', reason: task.state === 'interrupted' ? 'interrupted' : 'roundFailed', ...(task.error === undefined ? {} : { detail: clean(task.error) }) });
        return 'done';
      }
      if (settings.checks.length > 0) {
        const id = task.id;
        try {
          task = await this.withSlot(l, n, () => this.options.tasks.runBuildChecks(id, settings.checks));
        } catch (error) {
          if (this.stopping) return 'done';
          await this.updateTask(record.id, n, l.cancelling ? { state: 'cancelled' } : { state: 'waiting', reason: 'roundFailed', detail: await this.message(error) });
          return 'done';
        }
      }
      if (this.stopping) return 'done';
      if (l.cancelling) {
        await this.updateTask(record.id, n, { state: 'cancelled' });
        return 'done';
      }
      if (task.state !== 'proposal') {
        await this.updateTask(record.id, n, { state: 'waiting', reason: 'roundFailed', ...(task.error === undefined ? {} : { detail: clean(task.error) }) });
        return 'done';
      }
      const blocking = (task.validations ?? []).filter((validation) => validation.level === 'error');
      const failed = (task.checks ?? []).filter((check) => check.exitCode !== 0 || check.timedOut);
      const reason: WaitReason | undefined = blocking.length > 0 ? 'blocked' : failed.length > 0 ? 'checksFailed' : denied.length > 0 ? 'denied' : undefined;
      if (reason === undefined) return this.joinCard(record, n, task.id, settings.checks);
      const now = await this.load(record.id);
      if (fixesLeft <= 0 || now.roundsRun >= settings.maxRounds) {
        await this.updateTask(record.id, n, { state: 'waiting', reason });
        return 'done';
      }
      fixesLeft -= 1;
      const failures = failureText({ checks: task.checks ?? [], denied, validations: task.validations ?? [] });
      denied.length = 0;
      const roundNumber = task.rounds.length + 1;
      const id = task.id;
      try {
        await this.withSlot(l, n, () => this.options.tasks.newBuildRound(id, `Fix round ${roundNumber}`, round({ round: roundNumber, failures })));
        this.cancelIfAsked(l, id);
      } catch (error) {
        if (this.stopping) return 'done';
        await this.updateTask(record.id, n, l.cancelling ? { state: 'cancelled' } : { state: 'waiting', reason, detail: await this.message(error) });
        return 'done';
      }
    }
  }

  /**
   * A card's join, one at a time per build (BRIEF-phase-11 §2, 9): applied
   * (on the head it started at, or merged onto one that moved and checked
   * again there), or why it failed for its redo. A head moved between the
   * join's read and its compare and swap is joined again, a few times.
   */
  private joinCard(record: BuildRecord, n: number, taskId: string, checks: readonly string[]): Promise<'done' | JoinFailure> {
    const l = this.liveOf(record.id);
    const run = l.joins.then(async (): Promise<'done' | JoinFailure> => {
      for (let tries = 0; tries < JOIN_TRIES; tries += 1) {
        if (this.stopping) return 'done';
        if (l.cancelling) {
          await this.updateTask(record.id, n, { state: 'cancelled' });
          return 'done';
        }
        let joined: BuildJoin;
        try {
          joined = await this.withSlot(l, n, () => this.options.tasks.joinForBuild(taskId, checks));
        } catch (error) {
          if (this.stopping) return 'done';
          await this.updateTask(record.id, n, l.cancelling ? { state: 'cancelled' } : { state: 'waiting', reason: 'notApplied', detail: await this.message(error) });
          return 'done';
        }
        const summary = (results: readonly CheckResult[] | undefined) => (results === undefined ? {} : { checks: results.map((check) => ({ command: check.command, exitCode: check.exitCode, timedOut: check.timedOut })) });
        switch (joined.kind) {
          case 'applied':
            await this.updateTask(record.id, n, {
              state: 'applied',
              ...(joined.task.applied === undefined ? {} : { commit: joined.task.applied.commit }),
              join: { outcome: 'applied', merged: joined.merged, ...summary(joined.checks) },
            });
            return 'done';
          case 'conflict':
            await this.updateTask(record.id, n, { join: { outcome: 'conflict', merged: true, files: joined.files } });
            return 'conflict';
          case 'checksFailed':
            await this.updateTask(record.id, n, { join: { outcome: 'checksFailed', merged: true, ...summary(joined.checks) } });
            return 'checksFailed';
          case 'moved':
            continue;
          case 'aborted':
            if (this.stopping) return 'done';
            await this.updateTask(record.id, n, l.cancelling ? { state: 'cancelled' } : { state: 'waiting', reason: 'interrupted' });
            return 'done';
          case 'empty':
            await this.updateTask(record.id, n, { state: 'waiting', reason: 'notApplied', detail: await this.message(new BriefstackError('task.noChanges', { id: taskId })) });
            return 'done';
          case 'failed':
            await this.updateTask(record.id, n, { state: 'waiting', reason: 'notApplied', detail: clean(joined.message) });
            return 'done';
        }
      }
      await this.updateTask(record.id, n, { state: 'waiting', reason: 'notApplied', detail: await this.message(new BriefstackError('build.branchMoved', { branch: record.branch })) });
      return 'done';
    });
    l.joins = run.catch(() => undefined);
    return run;
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
      } else if ((record.state === 'running' || record.state === 'paused') && (await this.options.store.cancelMarked(record.id))) {
        // The user had asked to cancel it (step 33).
        await this.save(this.cancelledNow(record));
        await this.options.store.clearCancel(record.id);
        count += 1;
      } else if (record.state === 'running' || record.state === 'paused') {
        const tasks = record.tasks.map((task) => (task.state === 'running' ? { ...task, state: 'waiting' as const, reason: 'interrupted' as const } : task));
        // What the restart interrupted is kept for `autoResume()` (phase 12): running, or paused and why.
        const restart: NonNullable<BuildRecord['restart']> = record.state === 'running' ? { from: 'running' } : { from: 'paused', ...(record.pause === undefined ? {} : { pause: record.pause }) };
        const next: BuildRecord = { ...record, tasks, state: 'interrupted', restart, updatedAt: this.now().toISOString() };
        delete next.pause;
        await this.save(next);
        count += 1;
      }
    }
    return count;
  }

  /** The machine's cap on slots now (phase 12): `MAX_SLOTS` without one, or when it cannot be read. */
  async slotsCapNow(): Promise<number> {
    const cap = await (this.options.slotsCap?.() ?? Promise.resolve(MAX_SLOTS)).catch(() => MAX_SLOTS);
    return Number.isInteger(cap) && cap >= 1 ? Math.min(cap, MAX_SLOTS) : MAX_SLOTS;
  }

  /**
   * Builds resume by themselves after a restart (phase 12; PLAN-phase-12
   * §1, 13; H0, 5), when the setting is on. Called once at start, after
   * both `recover()` calls. Only what this restart interrupted: one the user
   * had paused stays interrupted; one paused for usage goes back to paused
   * with its timer (or resumes, its time passed); one that was running
   * resumes with the usage read first, its interrupted cards started again
   * at the integration head whatever its slots. One that resumed by itself
   * `MAX_AUTO_RESUMES` times in a row without a card ending stays
   * interrupted, and says so. Returns the ids it resumed or paused again.
   */
  async autoResume(): Promise<string[]> {
    const done: string[] = [];
    for (const listed of await this.options.store.list()) {
      if (listed.state !== 'interrupted' || listed.restart === undefined) continue;
      const l = this.liveOf(listed.id);
      const acted = await this.serial(l, async () => {
        if (this.stopping) return false;
        const record = await this.load(listed.id);
        const restart = record.restart;
        if (record.state !== 'interrupted' || restart === undefined || l.loop !== undefined) return false;
        if (restart.from === 'paused' && (restart.pause === undefined || restart.pause.reason === 'user')) return false;
        if ((record.autoResumes ?? 0) >= MAX_AUTO_RESUMES) {
          if (record.autoResumeStopped !== true) await this.save({ ...record, autoResumeStopped: true, updatedAt: this.now().toISOString() });
          return false;
        }
        const until = restart.pause?.until === undefined ? undefined : new Date(restart.pause.until);
        if (restart.from === 'paused' && restart.pause !== undefined && until !== undefined && until.getTime() > this.now().getTime()) {
          // Paused for usage: back to paused with its timer, as if the server had not stopped. Its cards were not at work.
          const next: BuildRecord = { ...record, state: 'paused', pause: restart.pause, autoResumes: (record.autoResumes ?? 0) + 1, updatedAt: this.now().toISOString() };
          delete next.restart;
          await this.save(next);
          this.wakeAt(record.id, until);
          return true;
        }
        await this.resumeLocked(record.id, l, true);
        return true;
      });
      if (acted) done.push(listed.id);
    }
    return done;
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
      this.wakeAll(l);
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

  /** A running or paused record whose cancel was asked, as cancelled: what a restart or a failed loop leaves. */
  private cancelledNow(record: BuildRecord): BuildRecord {
    const tasks = record.tasks.map((task) => (task.state === 'running' ? { ...task, state: 'cancelled' as const } : task));
    const next: BuildRecord = { ...record, tasks, state: 'cancelled', finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
    delete next.pause;
    return next;
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

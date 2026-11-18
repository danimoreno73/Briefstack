import { systemPathEnv, type PathEnv } from '../config/paths.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import type { Effort } from '../models.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { checkTaskPreconditions } from '../tasks/preconditions.js';
import type { TaskManager, TaskView } from '../tasks/manager.js';
import { newTaskId } from '../tasks/store.js';
import { redactSecretLines } from '../validate/secrets.js';
import { approvedListProblems } from './commands.js';
import { createIntegrationBranch, integrationHead } from './git.js';
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
}

/** How long a build waits for a free place in the shared limit before it tries again. */
export const SLOT_RETRY_MS = 30_000;

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
  /** Ends the current wait for a free place at once (a stop or a cancel). */
  wake?: () => void;
}

export interface BuildView extends BuildRecord {
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

  async get(id: string): Promise<BuildView> {
    const record = await this.options.store.load(id);
    if (record === undefined) throw new BriefstackError('build.notFound', { id });
    return this.view(record);
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
        maxRounds: Math.min(MAX_ROUNDS_CAP, tasks.length * (1 + fixRounds)),
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
   * Discards a build. Here only one that never started (`planned`, or
   * `planFailed`): it has no branch and no task, so the record just becomes
   * `discarded` and the project is free again (review of M3, I4). Runs in
   * the same line as plans and starts, so it cannot pass a start.
   */
  discard(id: string): Promise<BuildView> {
    const run = this.starting.then(() => this.discardNow(id));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private async discardNow(id: string): Promise<BuildView> {
    this.refuseWhileStopping();
    const record = await this.load(id);
    if (record.state !== 'planned' && record.state !== 'planFailed') throw new BriefstackError('build.wrongState', { id, state: record.state });
    const next: BuildRecord = { ...record, state: 'discarded', updatedAt: this.now().toISOString() };
    await this.save(next);
    return this.view(next);
  }

  // ---- the loop ---------------------------------------------------------------------------------

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (l === undefined) {
      l = { pausing: false, cancelling: false, skipUsage: false };
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
        l.pausing = false;
        await this.save({ ...record, state: 'paused', pause: { reason: 'user', at: this.now().toISOString() }, updatedAt: this.now().toISOString() });
        return;
      }
      record = this.skipBlocked(record);
      const started = record.tasks.filter((task) => task.state !== 'queued' && task.state !== 'skipped').length;
      const next = record.tasks.find((task) => task.state === 'queued' && task.dependsOn.every((n) => record.tasks[n - 1]?.state === 'applied'));
      if (next === undefined || started >= settings.limit) {
        await this.save({ ...record, state: 'finished', finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
        return;
      }
      if (record.roundsRun >= settings.maxRounds) {
        await this.save(this.withTask({ ...record, state: 'finished', finishedAt: this.now().toISOString() }, next.n, { state: 'waiting', reason: 'roundsCap' }));
        return;
      }
      // The plan usage before each task, unless the user just resumed it.
      if (l.skipUsage) l.skipUsage = false;
      else if (await this.pausedForUsage(record)) return;
      await this.runTask(record, next.n);
    }
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
  private async pausedForUsage(record: BuildRecord): Promise<boolean> {
    const read = this.options.usage;
    const thresholds = record.settings?.thresholds;
    if (read === undefined || thresholds === undefined) return false;
    const reading = await read().catch((error: unknown): UsageReading => ({ kind: 'failed', message: String(error) }));
    const decision = decideUsage(reading, thresholds, this.now(), this.options.usageRetryMs ?? USAGE_RETRY_MS);
    if (decision.go) return false;
    const fresh = await this.load(record.id);
    if (fresh.state !== 'running') return true;
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
    return true;
  }

  /** A paused build resumes by itself at `until` (the usage's reset), while this server runs. */
  private wakeAt(id: string, until: Date): void {
    const l = this.liveOf(id);
    if (l.timer !== undefined) clearTimeout(l.timer);
    l.timer = setTimeout(
      () => {
        delete l.timer;
        void this.resumeFromPause(id).catch(() => undefined);
      },
      Math.max(0, until.getTime() - this.now().getTime()),
    );
    l.timer.unref();
  }

  private async resumeFromPause(id: string): Promise<void> {
    if (this.stopping) return;
    const record = await this.load(id);
    if (record.state !== 'paused' || record.pause?.reason === 'user') return;
    const next: BuildRecord = { ...record, state: 'running', updatedAt: this.now().toISOString() };
    delete next.pause;
    await this.save(next);
    this.kick(id);
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
            const applied = await this.options.tasks.approve(task.id);
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

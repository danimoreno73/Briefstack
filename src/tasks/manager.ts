import { z } from 'zod';
import { DEFAULT_MAX_ACTIVE_CREATIONS } from '../config/limits.js';
import { systemPathEnv, type PathEnv } from '../config/paths.js';
import type { QuestionRequest, QuestionResult } from '../creation/types.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { appendEvent, readEvents, runnerEvent, sessionEventsFile, type RunnerLineFields, type SessionEvent } from '../events/index.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import type { Effort } from '../models.js';
import { hideAbsolutePaths, projectEvent } from '../panel/project.js';
import { redactSecretLines } from '../validate/secrets.js';
import { applyTask, discardTask, revertTask, type ApplyDeps } from './apply.js';
import { commitRound, createTaskWorktree, removeTaskWorktree } from './git.js';
import { proposalDiff, type ProposalDiff } from './proposal.js';
import { checkTaskPreconditions } from './preconditions.js';
import { roundPrompt, type TaskRunner, type TaskRunnerEvent, type TaskRunnerHandle, type TaskRunnerOutcome } from './runner.js';
import { inspectProject, projectRestrictions, type ProjectInspection } from './session.js';
import { TaskApprovals, TASK_DIALOG_TIMEOUT_MS, type ApprovalRequest, type CommandFeature, type ShellAnswer } from './shell.js';
import { newTaskId, type TaskStore } from './store.js';
import { branchOf, isActiveTask, type CheckResult, type TaskRecord, type TaskState, type TaskValidation } from './types.js';
import path from 'node:path';

/**
 * Tasks in existing projects (BRIEF-phase-7): their start, their rounds and
 * what the user is asked during them. Each round is one runner session in
 * the task's worktree; when it ends, the server commits its changes on the
 * task's branch and runs what comes after a round (`afterRound`: the
 * declared checks and the diff's validations), and the task waits on its
 * proposal page.
 */

export type TaskPendingKind = 'approval' | 'question';

/** A shell command or web request as the dialog shows it: never the raw command when part of it looks like a secret. */
export interface ApprovalPayload {
  kind: 'shell' | 'web';
  tool: string;
  text: string;
  redacted: boolean;
  features: CommandFeature[];
  compound: boolean;
  runsGit: boolean;
  agentType?: string;
}

export type TaskPending = { id: string; kind: 'approval'; payload: ApprovalPayload } | { id: string; kind: 'question'; payload: QuestionRequest };

/** What the API and the pages get of a task: the record, plus what only the server knows live. */
export interface TaskView extends TaskRecord {
  /** The request the user is asked now; others wait behind it. */
  pending?: TaskPending;
  /** The round's turn ended with nothing asked: a reply starts another turn, "finish" ends the round. */
  awaitingReply?: { lastMessage: string; at: string };
  cancelling?: true;
  /** Paths that were uncommitted in the project folder when the task started: not in the task. */
  uncommitted?: string[];
  /** Agents Claude Code would refuse, and imports that do not load in a task (warnings, BRIEF §3.2). */
  warnings?: { agentsWithoutTools: string[]; externalImports: { file: string; target: string }[] };
  /** How many exact commands, addresses and queries the user allowed for the rest of the task. */
  allowedForTask?: number;
}

/** One item of a task's live stream, as creations stream theirs (`flow`, `hook`, `runner` carry `events.jsonl` lines). */
export interface TaskStreamEvent {
  seq: number;
  ts: string;
  /** The round the item belongs to. */
  round: number;
  kind: 'flow' | 'hook' | 'runner' | 'status' | 'approval' | 'question' | 'denied';
  data: unknown;
}

export interface AfterRoundResult {
  checks: CheckResult[];
  validations: TaskValidation[];
}

export interface TaskManagerOptions {
  runner: TaskRunner;
  store: TaskStore;
  sessionsDir: string;
  /** The library and the repo, read at each start (Settings can move the library). */
  locations: () => Promise<{ libraryDir: string; repoDir: string }>;
  lang: () => Lang | Promise<Lang>;
  /** The active usage profile's name and `work` entry. */
  profile: () => Promise<{ name: string; model: string; effort: Effort }>;
  /** The creations side of the shared limit and of the folder rule. */
  creations?: { activeIds(): readonly string[]; folderHolder(dir: string): string | undefined | Promise<string | undefined> };
  /** The shared limit (config `maxActiveCreations`). Default 2. */
  maxActive?: () => number | Promise<number>;
  /** Runs after each round that ended: the declared checks and the validations (M5). Without it, none. */
  afterRound?: (task: TaskRecord, worktree: string) => Promise<AfterRoundResult>;
  pathEnv?: PathEnv;
  now?: () => Date;
  /** How often `events.jsonl` is read. Default 300 ms. */
  pollMs?: number;
  /** A dialog not answered for this long is a deny. Default `TASK_DIALOG_TIMEOUT_MS`. */
  dialogTimeoutMs?: number;
}

interface Subscriber {
  listener: (event: TaskStreamEvent) => void;
  onEnd: () => void;
}

interface QueuedRequest {
  pending: TaskPending;
  resolve: (value: unknown) => void;
  timer?: NodeJS.Timeout;
}

interface Live {
  record: TaskRecord;
  approvals: TaskApprovals;
  handle?: TaskRunnerHandle;
  queue: QueuedRequest[];
  nextPending: number;
  awaitingReply?: { lastMessage: string; at: string };
  cancelling: boolean;
  uncommitted: string[];
  inspection?: ProjectInspection;
  buffer: TaskStreamEvent[];
  subscribers: Set<Subscriber>;
  sessionId?: string;
  consumed: number;
  pollTimer?: NodeJS.Timeout | undefined;
  pollChain: Promise<void>;
  writeChain: Promise<void>;
  /** Actions on one task run one at a time. */
  acting: Promise<unknown>;
  /** Settles once the last round's end was recorded. */
  roundEnded: Promise<void>;
}

const questionAnswerSchema = z.record(z.string(), z.string().trim().min(1));
const approvalAnswerSchema = z.enum(['once', 'task', 'deny']);

const issuesOf = (error: z.ZodError): string[] => error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message));

const MAX_DESCRIPTION = 20_000;

export class TaskManager {
  private readonly live = new Map<string, Live>();
  private readonly options: TaskManagerOptions;
  private readonly now: () => Date;
  private readonly pathEnv: PathEnv;
  private starting: Promise<unknown> = Promise.resolve();

  constructor(options: TaskManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.pathEnv = options.pathEnv ?? systemPathEnv();
  }

  // ---- public API ------------------------------------------------------------------------------

  /** Tasks with a session or checks running now: they count against the shared limit. */
  activeIds(): string[] {
    return [...this.live.values()].filter((l) => isActiveTask(l.record.state)).map((l) => l.record.id);
  }

  async limit(): Promise<number> {
    return (await this.options.maxActive?.()) ?? DEFAULT_MAX_ACTIVE_CREATIONS;
  }

  /** Every task, newest first: the live ones as the server knows them, the rest from their records. */
  async list(): Promise<TaskView[]> {
    const stored = await this.options.store.list();
    return stored.map((record) => {
      const l = this.live.get(record.id);
      return l === undefined ? structuredClone(record) : this.view(l);
    });
  }

  async get(id: string): Promise<TaskView> {
    const l = this.live.get(id);
    if (l !== undefined) return this.view(l);
    const record = await this.options.store.load(id);
    if (record === undefined) throw new BriefstackError('task.notFound', { id });
    return record;
  }

  /**
   * Starts a task: the preconditions (BRIEF §3.1), the worktree from the
   * default branch's last commit, the project's definitions checked, then
   * the first round. Starts run one at a time, so the limit and the "one
   * task per project" rule cannot be passed twice at once.
   */
  start(project: string, description: string): Promise<TaskView> {
    const text = description.trim();
    const run = this.starting.then(() => this.startNow(project, text));
    this.starting = run.catch(() => undefined);
    return run;
  }

  /** Answers the pending request `pendingId`. */
  answer(id: string, pendingId: string, answer: unknown): TaskView {
    const l = this.find(id);
    const head = l.queue[0];
    if (head === undefined || l.record.state !== 'running') throw new BriefstackError('creation.noPending', { id });
    if (head.pending.id !== pendingId) throw new BriefstackError('creation.wrongPending', { pendingId, expected: head.pending.id });
    if (head.pending.kind === 'approval') {
      const parsed = approvalAnswerSchema.safeParse(answer);
      if (!parsed.success) throw new BriefstackError('creation.invalidAnswer', { kind: 'approval', issues: issuesOf(parsed.error) });
      // A command the dialog could not show whole is never allowed: the user would allow what they did not see.
      if (head.pending.payload.redacted && parsed.data !== 'deny') {
        throw new BriefstackError('creation.invalidAnswer', { kind: 'approval', issues: ['part of it is hidden, so it can only be denied'] });
      }
      this.settle(l, parsed.data, parsed.data);
    } else {
      if (answer === 'cancel') {
        this.settle(l, { decision: 'cancel' } satisfies QuestionResult, 'cancel');
      } else {
        const parsed = questionAnswerSchema.safeParse(answer);
        if (!parsed.success) throw new BriefstackError('creation.invalidAnswer', { kind: 'question', issues: issuesOf(parsed.error) });
        this.settle(l, { decision: 'answer', answers: parsed.data } satisfies QuestionResult, parsed.data);
      }
    }
    return this.view(l);
  }

  /** The user's free-text reply to a turn that ended waiting for text. */
  reply(id: string, text: string): TaskView {
    const l = this.find(id);
    if (l.awaitingReply === undefined || l.handle === undefined || l.record.state !== 'running') throw new BriefstackError('creation.noReply', { id });
    delete l.awaitingReply;
    l.handle.sendMessage(text);
    this.pushStatus(l);
    return this.view(l);
  }

  /** The user is done with this round: the session ends, its changes are committed and checked. */
  finishRound(id: string): TaskView {
    const l = this.find(id);
    if (l.record.state !== 'running' || l.handle === undefined) throw new BriefstackError('task.wrongState', { id, state: l.record.state });
    l.handle.finish();
    return this.view(l);
  }

  /** Cancels the running round (the existing cancel action): the guard denies everything, the session stops. */
  cancel(id: string): TaskView {
    const l = this.find(id);
    if (l.record.state !== 'running') throw new BriefstackError('task.wrongState', { id, state: l.record.state });
    if (!l.cancelling) {
      l.cancelling = true;
      this.settleAll(l);
      l.handle?.requestCancel();
      void l.handle?.stop();
      this.pushStatus(l);
    }
    return this.view(l);
  }

  /** Streams a task's items from `fromSeq` on; `onEnd` when the stream ends. Returns the unsubscribe function. */
  subscribe(id: string, fromSeq: number, listener: (event: TaskStreamEvent) => void, onEnd: () => void = () => undefined): () => void {
    const l = this.live.get(id);
    if (l === undefined) {
      onEnd();
      return () => undefined;
    }
    for (const event of l.buffer.slice(fromSeq)) listener(event);
    const subscriber: Subscriber = { listener, onEnd };
    l.subscribers.add(subscriber);
    return () => l.subscribers.delete(subscriber);
  }

  /**
   * After a server start: tasks the last server left running are
   * interrupted (their worktree stays; the user can ask for a new round or
   * discard them).
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const record of await this.options.store.list()) {
      if (!isActiveTask(record.state) || this.live.has(record.id)) continue;
      const round = record.rounds.at(-1);
      if (round !== undefined && round.finishedAt === undefined) {
        round.finishedAt = this.now().toISOString();
        round.outcome = 'interrupted';
      }
      await this.options.store.save({ ...record, state: 'interrupted', updatedAt: this.now().toISOString() });
      count += 1;
    }
    return count;
  }

  /** Stops every round; what was running is interrupted. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.live.values()].map(async (l) => {
        if (l.handle !== undefined && l.record.state === 'running') {
          this.settleAll(l);
          await l.handle.stop().catch(() => undefined);
        }
        await l.roundEnded;
      }),
    );
  }

  /**
   * Runs `action` on a task while no other action runs on it (M6: approve,
   * ask for changes, discard, revert). Exposed for the proposal actions.
   */
  async act<T>(id: string, action: (record: TaskRecord) => Promise<T>): Promise<T> {
    const l = this.live.get(id);
    const run = async (): Promise<T> => {
      const record = l?.record ?? (await this.options.store.load(id));
      if (record === undefined) throw new BriefstackError('task.notFound', { id });
      return action(record);
    };
    if (l === undefined) return run();
    const next = l.acting.then(run, run);
    l.acting = next.catch(() => undefined);
    return next;
  }

  /** Starts another round on the same worktree and branch (ask for changes, M6). */
  async newRound(id: string, changes: string): Promise<TaskView> {
    return this.act(id, async (record) => {
      if (!['proposal', 'failed', 'cancelled', 'interrupted'].includes(record.state)) throw new BriefstackError('task.wrongState', { id, state: record.state });
      const l = this.live.get(id) ?? this.adopt(record);
      const limit = await this.limit();
      const active = [...this.activeIds(), ...(this.options.creations?.activeIds() ?? [])];
      if (active.length >= limit) throw new BriefstackError('task.limit', { limit, active });
      await this.startRound(l, changes.trim());
      return this.view(l);
    });
  }

  /** Approve on the proposal page: one commit on the default branch (BRIEF §3.5). */
  approve(id: string): Promise<TaskView> {
    return this.act(id, async (record) => this.update(await applyTask(record, await this.applyDeps())));
  }

  /** Revert an applied task with one commit, after the user confirmed it. */
  revert(id: string): Promise<TaskView> {
    return this.act(id, async (record) => this.update(await revertTask(record, await this.applyDeps())));
  }

  /** Discard: the branch and the worktree go. Nothing allowed for the task is kept. */
  discard(id: string): Promise<TaskView> {
    return this.act(id, async (record) => {
      const view = await this.update(await discardTask(record, await this.applyDeps()));
      await this.live.get(id)?.approvals.clear();
      return view;
    });
  }

  /** What the proposal page shows: the task and its diff (the applied commit's, once applied). */
  async proposal(id: string): Promise<{ task: TaskView; diff: ProposalDiff | null }> {
    const task = await this.get(id);
    let diff: ProposalDiff | null = null;
    try {
      if (['proposal', 'failed', 'cancelled', 'interrupted', 'checking'].includes(task.state)) diff = await proposalDiff(task.projectDir, task.baseCommit, `refs/heads/${task.branch}`);
      else if (task.applied !== undefined) diff = await proposalDiff(task.projectDir, `${task.applied.commit}^`, task.applied.commit);
    } catch {
      diff = null;
    }
    return { task, diff };
  }

  /**
   * Whether a task can start on a project now, for its page: the first
   * precondition that fails (its code and message) or where it would
   * start, with the uncommitted paths it leaves out.
   */
  async startInfo(project: string): Promise<{ ok: true; branch: string; uncommitted: string[] } | { ok: false; code: string; params: Readonly<Record<string, unknown>>; message: string }> {
    const { libraryDir, repoDir } = await this.options.locations();
    const limit = await this.limit();
    try {
      const start = await checkTaskPreconditions(
        {
          libraryDir,
          repoDir,
          pathEnv: this.pathEnv,
          tasks: () => this.options.store.list(),
          creationOn: (dir) => this.options.creations?.folderHolder(dir),
          active: async () => {
            const ids = [...this.activeIds(), ...(this.options.creations?.activeIds() ?? [])];
            return { count: ids.length, limit, ids };
          },
        },
        project,
      );
      return { ok: true, branch: start.branch, uncommitted: start.uncommitted };
    } catch (error) {
      if (!isBriefstackError(error)) throw error;
      return { ok: false, code: error.code, params: error.params as Readonly<Record<string, unknown>>, message: formatError(error, await this.options.lang()) };
    }
  }

  private async applyDeps(): Promise<ApplyDeps> {
    const { libraryDir } = await this.options.locations();
    return { store: this.options.store, libraryDir, now: this.now };
  }

  /** Saves a record a proposal action changed, and tells the stream. */
  async update(record: TaskRecord): Promise<TaskView> {
    record.updatedAt = this.now().toISOString();
    await this.options.store.save(record);
    const l = this.live.get(record.id);
    if (l === undefined) return record;
    l.record = record;
    this.pushStatus(l);
    if (!['proposal', 'failed', 'cancelled', 'interrupted', 'running', 'checking'].includes(record.state)) this.endStream(l);
    return this.view(l);
  }

  // ---- start and rounds ------------------------------------------------------------------------

  private async startNow(project: string, description: string): Promise<TaskView> {
    if (description === '' || description.length > MAX_DESCRIPTION) throw new BriefstackError('web.invalidBody', { issues: [`description: 1 to ${MAX_DESCRIPTION} characters`] });
    const { libraryDir, repoDir } = await this.options.locations();
    const limit = await this.limit();
    const start = await checkTaskPreconditions(
      {
        libraryDir,
        repoDir,
        pathEnv: this.pathEnv,
        tasks: () => this.options.store.list(),
        creationOn: (dir) => this.options.creations?.folderHolder(dir),
        active: async () => {
          const ids = [...this.activeIds(), ...(this.options.creations?.activeIds() ?? [])];
          return { count: ids.length, limit, ids };
        },
      },
      project,
    );
    const profile = await this.options.profile();
    const id = newTaskId(this.now());
    const at = this.now().toISOString();
    const record: TaskRecord = {
      v: 1,
      id,
      project: start.slug,
      projectDir: start.dir,
      description,
      profile: profile.name,
      model: profile.model,
      effort: profile.effort,
      state: 'running',
      baseBranch: start.branch,
      baseCommit: start.head,
      branch: branchOf(id),
      hidden: [],
      createdAt: at,
      updatedAt: at,
      rounds: [],
    };
    // The last check of the shared limit and the registration happen with no await between them.
    const active = [...this.activeIds(), ...(this.options.creations?.activeIds() ?? [])];
    if (active.length >= limit) throw new BriefstackError('task.limit', { limit, active });
    const l = this.adopt(record);
    l.uncommitted = start.uncommitted;

    const worktree = this.options.store.worktreeDir(id);
    try {
      const created = await createTaskWorktree(start.dir, worktree, record.branch, start.head);
      record.hidden = created.hidden;
      const inspection = await inspectProject(worktree);
      if (inspection.unsafe.length > 0) throw new BriefstackError('task.unsafeDefinitions', { project: start.slug, items: inspection.unsafe });
      l.inspection = inspection;
      await this.startRound(l, undefined);
    } catch (error) {
      this.live.delete(id);
      await removeTaskWorktree(start.dir, worktree, record.branch).catch(() => undefined);
      await this.options.store.remove(id).catch(() => undefined);
      throw error;
    }
    return this.view(l);
  }

  /** The live side of a task, made from its record. */
  private adopt(record: TaskRecord): Live {
    const existing = this.live.get(record.id);
    if (existing !== undefined) return existing;
    const l: Live = {
      record,
      approvals: undefined as unknown as TaskApprovals,
      queue: [],
      nextPending: 0,
      cancelling: false,
      uncommitted: [],
      buffer: [],
      subscribers: new Set(),
      consumed: 0,
      pollChain: Promise.resolve(),
      writeChain: Promise.resolve(),
      acting: Promise.resolve(),
      roundEnded: Promise.resolve(),
    };
    l.approvals = new TaskApprovals(path.join(this.options.store.taskDir(record.id), 'approvals'), (request) => this.ask(l, request));
    this.live.set(record.id, l);
    return l;
  }

  private async startRound(l: Live, changes: string | undefined): Promise<void> {
    const { record } = l;
    const n = record.rounds.length + 1;
    const worktree = this.options.store.worktreeDir(record.id);
    l.inspection ??= await inspectProject(worktree);
    const restrictions = await projectRestrictions(record.projectDir, record.baseCommit);
    record.rounds.push({ n, text: changes ?? record.description, startedAt: this.now().toISOString() });
    record.state = 'running';
    delete record.checks;
    delete record.validations;
    delete record.error;
    l.cancelling = false;
    delete l.awaitingReply;
    delete l.sessionId;
    l.consumed = 0;
    record.updatedAt = this.now().toISOString();
    await this.options.store.save(record);
    const lang = await this.options.lang();
    const handle = this.options.runner.start({
      taskId: record.id,
      project: record.project,
      round: n,
      prompt: roundPrompt({ description: record.description, round: n, ...(changes === undefined ? {} : { changes }), lang }),
      worktree,
      model: record.model,
      effort: record.effort,
      sessionsDir: this.options.sessionsDir,
      skills: l.inspection.skills,
      restrictions,
      rulesFile: this.options.store.rulesFile(record.id),
      approvalsDir: path.join(this.options.store.taskDir(record.id), 'approvals'),
      approvals: l.approvals,
      io: {
        askQuestions: (request) => this.request<QuestionResult>(l, { id: '', kind: 'question', payload: request }),
        emit: (event) => this.onRunnerEvent(l, event),
      },
    });
    l.handle = handle;
    this.pushStatus(l);
    void handle.sessionId.then(
      (sessionId) => {
        if (l.handle !== handle) return;
        l.sessionId = sessionId;
        const round = record.rounds.at(-1);
        if (round !== undefined) round.sessionId = sessionId;
        void this.options.store.save(record).catch(() => undefined);
        this.recordLine(l, { type: 'session.profile', profile: record.profile, model: record.model, effort: record.effort });
        this.pushStatus(l);
        this.schedulePoll(l);
      },
      () => undefined,
    );
    l.roundEnded = handle.done
      .catch((error: unknown): TaskRunnerOutcome => ({ kind: 'failed', error: String(error) }))
      .then((outcome) => this.onRoundDone(l, handle, outcome))
      .catch(() => undefined);
  }

  private async onRoundDone(l: Live, handle: TaskRunnerHandle, outcome: TaskRunnerOutcome): Promise<void> {
    if (l.handle !== handle) return;
    this.settleAll(l);
    await this.flush(l);
    await l.writeChain;
    if (l.pollTimer !== undefined) clearTimeout(l.pollTimer);
    l.pollTimer = undefined;
    delete l.handle;
    delete l.awaitingReply;
    const { record } = l;
    const round = record.rounds.at(-1);
    if (round === undefined) return;
    round.finishedAt = this.now().toISOString();
    if (l.cancelling || outcome.kind === 'stopped') {
      round.outcome = l.cancelling ? 'cancelled' : 'interrupted';
      record.state = l.cancelling ? 'cancelled' : 'interrupted';
    } else if (outcome.kind === 'failed') {
      round.outcome = 'failed';
      round.error = this.clean(outcome.error);
      record.state = 'failed';
      record.error = round.error;
    } else {
      round.outcome = 'completed';
      if (outcome.summary !== undefined) round.summary = redactSecretLines(outcome.summary).slice(0, 4000);
      record.state = 'checking';
      record.updatedAt = this.now().toISOString();
      await this.options.store.save(record);
      this.pushStatus(l);
      try {
        const commit = await commitRound(this.options.store.worktreeDir(record.id), `briefstack task ${record.id}, round ${round.n}`);
        if (commit !== undefined) round.commit = commit;
        const after = (await this.options.afterRound?.(record, this.options.store.worktreeDir(record.id))) ?? { checks: [], validations: [] };
        record.checks = after.checks;
        record.validations = after.validations;
        record.state = 'proposal';
      } catch (error) {
        record.state = 'failed';
        record.error = this.clean(isBriefstackError(error) ? formatError(error, await this.options.lang()) : error instanceof Error ? error.message : String(error));
      }
    }
    record.updatedAt = this.now().toISOString();
    await this.options.store.save(record);
    this.pushStatus(l);
  }

  // ---- requests to the user --------------------------------------------------------------------

  private ask(l: Live, request: ApprovalRequest): Promise<ShellAnswer> {
    const payload: ApprovalPayload = {
      kind: request.kind,
      tool: request.tool,
      text: request.display.text,
      redacted: request.display.redacted,
      features: request.display.features,
      compound: request.display.compound,
      runsGit: request.display.runsGit,
      ...(request.agentType === undefined ? {} : { agentType: request.agentType }),
    };
    return this.request<ShellAnswer>(l, { id: '', kind: 'approval', payload });
  }

  private request<T>(l: Live, pending: TaskPending): Promise<T> {
    if (l.cancelling || l.record.state !== 'running') return Promise.resolve((pending.kind === 'approval' ? 'deny' : { decision: 'cancel' }) as T);
    l.nextPending += 1;
    const item = { ...pending, id: `p${l.nextPending}` } as TaskPending;
    delete l.awaitingReply;
    return new Promise<T>((resolve) => {
      const queued: QueuedRequest = { pending: item, resolve: resolve as (value: unknown) => void };
      queued.timer = setTimeout(() => {
        if (l.queue[0] === queued) this.settle(l, item.kind === 'approval' ? 'deny' : { decision: 'cancel' }, 'timeout');
        else {
          l.queue = l.queue.filter((other) => other !== queued);
          queued.resolve(item.kind === 'approval' ? 'deny' : { decision: 'cancel' });
        }
      }, this.options.dialogTimeoutMs ?? TASK_DIALOG_TIMEOUT_MS);
      queued.timer.unref();
      l.queue.push(queued);
      if (l.queue.length === 1) this.activate(l);
    });
  }

  private activate(l: Live): void {
    const head = l.queue[0];
    if (head === undefined) return;
    this.push(l, { kind: head.pending.kind, data: { pendingId: head.pending.id, state: 'pending', payload: head.pending.payload } });
    this.pushStatus(l);
  }

  private settle(l: Live, result: unknown, shown: unknown): void {
    const head = l.queue.shift();
    if (head === undefined) return;
    if (head.timer !== undefined) clearTimeout(head.timer);
    this.push(l, { kind: head.pending.kind, data: { pendingId: head.pending.id, state: 'answered', answer: shown } });
    head.resolve(result);
    this.activate(l);
    if (l.queue.length === 0) this.pushStatus(l);
  }

  private settleAll(l: Live): void {
    while (l.queue.length > 0) {
      const head = l.queue[0];
      this.settle(l, head?.pending.kind === 'approval' ? 'deny' : { decision: 'cancel' }, 'cancel');
    }
  }

  // ---- stream ----------------------------------------------------------------------------------

  private onRunnerEvent(l: Live, event: TaskRunnerEvent): void {
    if (event.kind === 'status' && event.status === 'turnEnded') {
      l.awaitingReply = { lastMessage: hideAbsolutePaths(redactSecretLines(event.message ?? '')).slice(0, 4000), at: this.now().toISOString() };
      this.pushStatus(l);
      return;
    }
    if (event.kind === 'status' && event.status === 'running') {
      delete l.awaitingReply;
      this.pushStatus(l);
      return;
    }
    if (event.kind === 'denial') {
      const reason = hideAbsolutePaths(redactSecretLines(event.reason)).slice(0, 300);
      this.push(l, { kind: 'denied', data: { toolName: event.toolName, reason, at: this.now().toISOString(), ...(event.agentType === undefined ? {} : { agentType: event.agentType }) } });
      this.recordLine(l, {
        type: 'tool.denied',
        tool: event.toolName,
        by: reason === 'The user did not allow this.' ? 'user' : 'guard',
        reason,
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
        ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
      });
    }
  }

  /** A `source: "runner"` line in the round's `events.jsonl`, once the session id is known. */
  private recordLine(l: Live, fields: RunnerLineFields): void {
    const session = l.sessionId;
    if (session === undefined) return;
    l.writeChain = l.writeChain.then(() => appendEvent(this.options.sessionsDir, runnerEvent(session, fields, this.now()))).then(
      () => undefined,
      () => undefined,
    );
  }

  private schedulePoll(l: Live): void {
    if (l.pollTimer !== undefined || l.handle === undefined) return;
    l.pollTimer = setTimeout(() => {
      l.pollTimer = undefined;
      void this.flush(l).then(() => this.schedulePoll(l));
    }, this.options.pollMs ?? 300);
    l.pollTimer.unref();
  }

  private flush(l: Live): Promise<void> {
    l.pollChain = l.pollChain.then(() => this.readNew(l)).catch(() => undefined);
    return l.pollChain;
  }

  private async readNew(l: Live): Promise<void> {
    const session = l.sessionId;
    if (session === undefined) return;
    const { events } = await readEvents(sessionEventsFile(this.options.sessionsDir, session));
    for (const event of events.slice(l.consumed) as SessionEvent[]) {
      l.consumed += 1;
      if (event.source === 'hook' || event.source === 'runner') this.push(l, { kind: event.source, data: projectEvent(event, l.consumed) });
      else this.push(l, { kind: 'flow', data: event });
    }
  }

  private push(l: Live, item: { kind: TaskStreamEvent['kind']; data: unknown }): void {
    const event: TaskStreamEvent = { seq: l.buffer.length + 1, ts: this.now().toISOString(), round: l.record.rounds.length, ...item };
    l.buffer.push(event);
    for (const subscriber of [...l.subscribers]) subscriber.listener(event);
  }

  private pushStatus(l: Live): void {
    const view = this.view(l);
    this.push(l, {
      kind: 'status',
      data: {
        state: view.state,
        ...(view.awaitingReply === undefined ? {} : { awaitingReply: view.awaitingReply }),
        ...(view.cancelling === undefined ? {} : { cancelling: true }),
        ...(l.sessionId === undefined ? {} : { sessionId: l.sessionId }),
      },
    });
  }

  private endStream(l: Live): void {
    for (const subscriber of [...l.subscribers]) subscriber.onEnd();
    l.subscribers.clear();
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private find(id: string): Live {
    const l = this.live.get(id);
    if (l === undefined) throw new BriefstackError('task.notFound', { id });
    return l;
  }

  private clean(text: string): string {
    return hideAbsolutePaths(redactSecretLines(text)).slice(0, 2000);
  }

  private view(l: Live): TaskView {
    const view: TaskView = structuredClone(l.record);
    const head = l.queue[0];
    if (head !== undefined && l.record.state === 'running') view.pending = structuredClone(head.pending);
    if (l.awaitingReply !== undefined && l.record.state === 'running' && head === undefined) view.awaitingReply = { ...l.awaitingReply };
    if (l.cancelling && l.record.state === 'running') view.cancelling = true;
    if (l.uncommitted.length > 0) view.uncommitted = [...l.uncommitted];
    if (l.inspection !== undefined && (l.inspection.agentsWithoutTools.length > 0 || l.inspection.externalImports.length > 0)) {
      view.warnings = { agentsWithoutTools: [...l.inspection.agentsWithoutTools], externalImports: l.inspection.externalImports.map((item) => ({ ...item })) };
    }
    if (l.approvals.size > 0) view.allowedForTask = l.approvals.size;
    return view;
  }

  /** For the tests: the state of a task as the stream last said. */
  stateOf(id: string): TaskState | undefined {
    return this.live.get(id)?.record.state;
  }
}

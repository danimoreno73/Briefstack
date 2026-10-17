import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { DEFAULT_MAX_ACTIVE_CREATIONS } from '../config/limits.js';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import {
  EVENT_FORMAT,
  appendEvent,
  flowEvent,
  readEvents,
  runnerEvent,
  sessionEventsFile,
  sessionLifecycleEvent,
  type DenialSource,
  type FlowEvent,
  type FlowStep,
  type HookEvent,
  type RunnerLineEvent,
  type RunnerLineFields,
  type SessionEvent,
  type SessionLifecycleEvent,
  type SessionOutcome,
} from '../events/index.js';
import { hideAbsolutePaths, projectEvent } from '../panel/project.js';
import { redactSecretLines } from '../validate/secrets.js';
import type {
  CreationRunner,
  GrantRequest,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  QuestionRequest,
  QuestionResult,
  RunnerEvent,
  RunnerHandle,
  RunnerIO,
  RunnerOutcome,
  RunnerProfile,
  SpecApprovalRequest,
  SpecDecision,
} from './types.js';

/**
 * Creation sessions started from the web app (PLAN-phase-2 §3, "Creation
 * sessions"). The manager owns each runner, answers its io calls with what
 * the browser sends, and turns the session's `events.jsonl` plus runner
 * events into one numbered stream per creation.
 *
 * Creations are keyed by id so several can exist (phase 4); phase 2 allows
 * one active at a time. A creation ends only when `events.jsonl` has
 * `session.finished`, or when the server ends it (stop, cancel fallback,
 * runner gone): an SDK `result` is not the end.
 */

/** The fields of `spec.json` the approval screen shows. */
const SPEC_FIELDS = ['name', 'slug', 'summary', 'type', 'target', 'targetChosenBy', 'targetReason', 'profile', 'language'] as const;
export type SpecFields = Partial<Record<(typeof SPEC_FIELDS)[number], string>>;
const MAX_SPEC_FILE_BYTES = 256 * 1024;

export interface SpecView {
  /** `null` when the summary file is missing or not in the session folder. */
  summary: string | null;
  spec: SpecFields | null;
}

export type CreationStatus = 'running' | 'waiting' | 'finished';
/** `interrupted`: the server stopped, or the runner ended without closing the flow. */
export type CreationOutcome = SessionOutcome | 'interrupted';
export type PendingKind = 'question' | 'permission' | 'spec' | 'grant';

interface PendingPayloads {
  question: QuestionRequest;
  permission: PermissionRequest;
  spec: SpecApprovalRequest;
  grant: GrantRequest;
}

/** What the runner gets back for each kind. */
interface PendingResults {
  question: QuestionResult;
  permission: PermissionDecision;
  spec: SpecDecision;
  grant: boolean;
}

export type Pending = { [K in PendingKind]: { id: string; kind: K; payload: PendingPayloads[K] } }[PendingKind];

/** A request denied without asking, under the `unattended` policy. Listed on the result screen. */
export interface DeniedRequest {
  toolName: string;
  summary: string;
  agentType?: string;
  at: string;
}

export interface CreationState {
  id: string;
  /** The Claude Code session id (names the session folder), once the runner reports it. */
  sessionId?: string;
  idea: string;
  profile: string;
  policy: PermissionPolicy;
  status: CreationStatus;
  outcome?: CreationOutcome;
  /** The one request the user is asked now; others wait behind it. */
  pending?: Pending;
  /** Set once the user cancelled and the flow has not closed yet. */
  cancelling?: true;
  /**
   * Set when the session ended a turn and asks nothing in the browser: it
   * waits for a reply the page cannot send. `lastMessage` is the main
   * session's last text, redacted. Cleared when a turn starts or something is asked.
   */
  awaitingReply?: { lastMessage: string; at: string };
  denied: DeniedRequest[];
  /** Set from the start until the first plan usage reading arrived or failed. */
  usageReading?: true;
  /** Why the runner failed, when it did. Never contains tool inputs. */
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** A pending request's lifecycle, as streamed. `answer` is what the user (or a cancel) sent. */
export interface PendingEventData {
  pendingId: string;
  state: 'pending' | 'answered';
  payload?: unknown;
  answer?: unknown;
}

export interface StatusEventData {
  status: CreationStatus;
  outcome?: CreationOutcome;
  sessionId?: string;
  cancelling?: true;
  /** Progress reported by the runner itself. */
  runner?: RunnerEvent;
}

export type DeniedEventData = DeniedRequest & { by: 'policy' | 'runner'; reason?: string };

interface StreamBase {
  /** 1, 2, 3… per creation. */
  seq: number;
  ts: string;
}

/**
 * One item of a creation's live stream: the shape the browser and the phase 3
 * agent panel consume. `flow` and `hook` carry `events.jsonl` lines as they are.
 */
export type StreamEvent = StreamBase &
  (
    | { kind: 'flow'; data: FlowEvent | SessionLifecycleEvent }
    | { kind: 'hook'; data: HookEvent }
    /** Lines the server wrote to `events.jsonl` itself (`source: "runner"`): denials, profile, plan usage. */
    | { kind: 'runner'; data: RunnerLineEvent }
    | { kind: PendingKind; data: PendingEventData }
    | { kind: 'status'; data: StatusEventData }
    | { kind: 'denied'; data: DeniedEventData }
  );

export type StreamKind = StreamEvent['kind'];

export interface CreationManagerOptions {
  runner: CreationRunner;
  sessionsDir: string;
  /** Read when a creation starts; it applies to that creation until it ends. */
  policy: () => PermissionPolicy | Promise<PermissionPolicy>;
  /** The active usage profile's session model and effort. */
  profile: () => RunnerProfile | Promise<RunnerProfile>;
  /** How many creations may be active at once (config `maxActiveCreations`), read at each start. Default 2. */
  maxActive?: () => number | Promise<number>;
  now?: () => Date;
  /** How often `events.jsonl` is read. Default 300 ms. */
  pollMs?: number;
  /** After a cancel, how long the flow has to close the session before the server does. Default 60 s. */
  cancelTimeoutMs?: number;
  /** After `session.finished`, how long the runner has to end by itself before it is stopped. Default 30 s. */
  finishGraceMs?: number;
  /**
   * Once the creation finished and its runner is done, the wait before the
   * last read of `events.jsonl` that closes the stream, so a line Claude Code
   * writes as it exits (the hook's `session.end`) still reaches it. Default 1 s.
   */
  tailMs?: number;
  /**
   * Reads the plan usage (`src/creation/planUsage.ts`). Called once the
   * session id is known and every `usageEveryMs` while the creation runs;
   * each reading becomes a `usage` line. Without it, nothing is read.
   */
  planUsage?: () => Promise<{ fiveHour: number | null; sevenDay: number | null } | undefined>;
  /** Default 5 minutes. */
  usageEveryMs?: number;
}

type Listener = (event: StreamEvent) => void;

interface Subscriber {
  listener: Listener;
  onEnd: () => void;
}

interface QueuedRequest {
  pending: Pending;
  resolve: (value: unknown) => void;
}

interface Creation {
  state: CreationState;
  /** The last spec the flow asked about: the approval screen reads its files. */
  lastSpec?: SpecApprovalRequest | undefined;
  handle?: RunnerHandle;
  runnerDone: boolean;
  /** The server is ending the runner itself: its `done` is not a crash. */
  stopping: boolean;
  queue: QueuedRequest[];
  nextPending: number;
  buffer: StreamEvent[];
  subscribers: Set<Subscriber>;
  /** `events.jsonl` events already streamed. */
  consumed: number;
  /** The profile the creation runs with, recorded once the session id is known. */
  profile?: RunnerProfile;
  /** Runner lines asked for before the session id was known, written once it is. */
  unwritten: RunnerLineFields[];
  /** Runner lines are appended one after another, in the order they were asked for. */
  writeChain: Promise<void>;
  openStep?: FlowStep | undefined;
  pollTimer?: NodeJS.Timeout | undefined;
  pollChain: Promise<void>;
  cancelTimer?: NodeJS.Timeout | undefined;
  graceTimer?: NodeJS.Timeout | undefined;
  usageTimer?: NodeJS.Timeout | undefined;
  /** The stream ended: subscribers were closed after the last read of `events.jsonl`. */
  streamClosed: boolean;
  closing?: Promise<void>;
}

const questionAnswerSchema = z.record(z.string(), z.string().trim().min(1));
const answerSchemas = {
  question: questionAnswerSchema,
  permission: z.enum(['allow', 'deny']),
  spec: z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('approve') }),
    z.object({ decision: z.literal('change'), text: z.string().trim().min(1) }),
    z.object({ decision: z.literal('cancel') }),
  ]),
  grant: z.boolean(),
} as const;

/** The answer each kind gets when the creation is cancelled or ends. */
const CANCEL_ANSWERS: PendingResults = {
  question: { decision: 'cancel' },
  permission: 'deny',
  spec: { decision: 'cancel' },
  grant: false,
};

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message));

export class CreationManager {
  private readonly creations = new Map<string, Creation>();
  private readonly options: CreationManagerOptions;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly finishGraceMs: number;
  private readonly tailMs: number;

  constructor(options: CreationManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? 300;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 60_000;
    this.finishGraceMs = options.finishGraceMs ?? 30_000;
    this.tailMs = options.tailMs ?? 1000;
  }

  /** Starts a creation. Throws `creation.limit` when as many as the limit are active. */
  async create(idea: string): Promise<CreationState> {
    const limit = (await this.options.maxActive?.()) ?? DEFAULT_MAX_ACTIVE_CREATIONS;
    // From here to the registration below there is no await, so two starts at once both count.
    const active = [...this.creations.values()].filter((c) => c.state.status !== 'finished').map((c) => c.state.id);
    if (active.length >= limit) throw new BriefstackError('creation.limit', { limit, active });

    const c: Creation = {
      state: {
        id: randomUUID(),
        idea,
        profile: '',
        policy: 'ask',
        status: 'running',
        denied: [],
        // The first reading takes a few seconds: until then the panel says it is on its way, not "not available".
        ...(this.options.planUsage === undefined ? {} : { usageReading: true as const }),
        startedAt: this.now().toISOString(),
      },
      runnerDone: false,
      stopping: false,
      queue: [],
      nextPending: 0,
      buffer: [],
      subscribers: new Set(),
      consumed: 0,
      unwritten: [],
      writeChain: Promise.resolve(),
      pollChain: Promise.resolve(),
      streamClosed: false,
    };
    // Registered before any await, so a second create sees it.
    this.creations.set(c.state.id, c);

    try {
      c.state.policy = await this.options.policy();
      const profile = await this.options.profile();
      c.state.profile = profile.name;
      c.profile = profile;
      c.handle = this.options.runner.start({
        creationId: c.state.id,
        idea,
        profile,
        sessionsDir: this.options.sessionsDir,
        policy: c.state.policy,
        io: this.io(c),
      });
    } catch (error) {
      c.state.error = error instanceof Error ? error.message : String(error);
      this.finish(c, 'failed');
      throw error;
    }
    const handle = c.handle;
    if (c.state.cancelling) handle.requestCancel();

    void handle.sessionId.then(
      (sessionId) => {
        c.state.sessionId = sessionId;
        this.recordProfile(c);
        for (const fields of c.unwritten.splice(0)) this.record(c, fields);
        this.startUsage(c);
        this.pushStatus(c);
        this.schedulePoll(c);
      },
      () => undefined,
    );
    void handle.done
      .catch((error: unknown): RunnerOutcome => ({ kind: 'failed', error: String(error) }))
      .then((outcome) => this.onRunnerDone(c, outcome));
    this.pushStatus(c);
    return this.snapshot(c);
  }

  /**
   * The files of the spec the flow showed last, for the approval screen: the
   * summary as written (secrets hidden) and the fields of `spec.json` the
   * page shows. Both files must be inside this creation's session folder.
   */
  async readSpec(id: string): Promise<SpecView> {
    const c = this.find(id);
    const request = c.lastSpec;
    const session = c.state.sessionId;
    if (request === undefined || session === undefined) throw new BriefstackError('creation.noSpec', { id });
    const pathEnv = systemPathEnv();
    const folder = pathEnv.pathApi.join(this.options.sessionsDir, session);
    const read = async (file: string): Promise<string | undefined> => {
      if (!isPathInside(file, folder, pathEnv)) return undefined;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_SPEC_FILE_BYTES) return undefined;
        return await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    };
    const summary = await read(request.summaryFile);
    const specText = await read(request.specFile);
    let spec: SpecFields | null = null;
    if (specText !== undefined) {
      try {
        const parsed = JSON.parse(specText) as Record<string, unknown>;
        spec = {};
        for (const key of SPEC_FIELDS) {
          const value = parsed[key];
          if (typeof value === 'string') spec[key] = redactSecretLines(value);
        }
      } catch {
        spec = null;
      }
    }
    return { summary: summary === undefined ? null : redactSecretLines(summary), spec };
  }

  list(): CreationState[] {
    return [...this.creations.values()].map((c) => this.snapshot(c));
  }

  get(id: string): CreationState {
    return this.snapshot(this.find(id));
  }

  /**
   * Answers the pending request `pendingId`. The answer's shape depends on
   * its kind: question → `{ "<question text>": "<label or text>" }` for every
   * question; permission → `"allow" | "deny"`; spec → `{ decision: "approve" }`,
   * `{ decision: "change", text }` or `{ decision: "cancel" }`; grant → boolean.
   */
  answer(id: string, pendingId: string, answer: unknown): CreationState {
    const c = this.find(id);
    const head = c.queue[0];
    if (head === undefined || this.isFinished(c)) throw new BriefstackError('creation.noPending', { id });
    if (head.pending.id !== pendingId) {
      throw new BriefstackError('creation.wrongPending', { pendingId, expected: head.pending.id });
    }
    const { kind } = head.pending;
    const parsed = answerSchemas[kind].safeParse(answer);
    if (!parsed.success) throw new BriefstackError('creation.invalidAnswer', { kind, issues: issuesOf(parsed.error) });

    let result: unknown = parsed.data;
    if (head.pending.kind === 'question') {
      const answers = parsed.data as Record<string, string>;
      const expected = head.pending.payload.questions.map((q) => q.question);
      const issues = [
        ...expected.filter((q) => !(q in answers)).map((q) => `missing: ${q}`),
        ...Object.keys(answers)
          .filter((q) => !expected.includes(q))
          .map((q) => `unknown question: ${q}`),
      ];
      if (issues.length > 0) throw new BriefstackError('creation.invalidAnswer', { kind, issues });
      result = { decision: 'answer', answers } satisfies QuestionResult;
    }
    if (head.pending.kind === 'permission' && parsed.data === 'deny') {
      this.recordDenial(c, 'user', head.pending.payload.toolName, head.pending.payload.agentType);
    }
    this.settle(c, result, parsed.data);
    return this.snapshot(c);
  }

  /**
   * Cancels through the flow (BRIEF-phase-2 §3.2): a pending question or
   * spec is answered "cancel" (a permission "deny", a grant "no"), the
   * runner is asked to close at its next step, and if the session is still
   * open after `cancelTimeoutMs` the server stops the runner and writes the
   * close itself.
   */
  cancel(id: string): CreationState {
    const c = this.find(id);
    if (this.isFinished(c) || c.state.cancelling) return this.snapshot(c);
    c.state.cancelling = true;
    this.settleAll(c);
    this.pushStatus(c);
    c.handle?.requestCancel();
    c.cancelTimer = setTimeout(() => void this.cancelFallback(c), this.cancelTimeoutMs);
    c.cancelTimer.unref();
    return this.snapshot(c);
  }

  /**
   * Replays every event after `fromSeq`, then calls `listener` live.
   * `onEnd` runs once the creation has finished and everything was sent.
   * Returns the unsubscribe function.
   */
  subscribe(id: string, fromSeq: number, listener: Listener, onEnd: () => void = () => undefined): () => void {
    const c = this.find(id);
    for (const event of c.buffer) if (event.seq > fromSeq) listener(event);
    if (c.streamClosed) {
      onEnd();
      return () => undefined;
    }
    const subscriber: Subscriber = { listener, onEnd };
    c.subscribers.add(subscriber);
    return () => {
      c.subscribers.delete(subscriber);
    };
  }

  /**
   * Server stop: every active runner is stopped, and its session gets a
   * `session.end` with reason `server_stop`, so it reads as interrupted.
   */
  async shutdown(): Promise<void> {
    const work = [...this.creations.values()].map(async (c) => {
      if (this.isFinished(c)) {
        if (!c.runnerDone) await this.stopRunner(c);
        return;
      }
      await this.stopRunner(c);
      await this.flush(c);
      if (this.isFinished(c)) return;
      if (c.state.sessionId !== undefined) {
        const end: HookEvent = {
          v: EVENT_FORMAT,
          ts: this.now().toISOString(),
          session: c.state.sessionId,
          source: 'hook',
          type: 'session.end',
          reason: 'server_stop',
        };
        await appendEvent(this.options.sessionsDir, end).catch(() => undefined);
        await this.flush(c);
      }
      this.finish(c, 'interrupted');
    });
    await Promise.all(work);
    await Promise.all([...this.creations.values()].map((c) => this.closeStream(c)));
  }

  // ---- internals ----

  /** A method, not an inline check: the status changes across awaits. */
  private isFinished(c: Creation): boolean {
    return c.state.status === 'finished';
  }

  private find(id: string): Creation {
    const c = this.creations.get(id);
    if (c === undefined) throw new BriefstackError('creation.notFound', { id });
    return c;
  }

  private snapshot(c: Creation): CreationState {
    const state: CreationState = structuredClone({ ...c.state, denied: c.state.denied });
    const head = c.queue[0];
    if (head !== undefined && c.state.status !== 'finished') state.pending = structuredClone(head.pending);
    else delete state.pending;
    return state;
  }

  private io(c: Creation): RunnerIO {
    return {
      askQuestions: (request) => this.request(c, 'question', request),
      requestPermission: async (raw) => {
        // Whatever a runner passes, a secret never reaches the page or the history.
        const request: PermissionRequest = { ...raw, summary: redactSecretLines(raw.summary) };
        if (c.state.policy !== 'unattended') return this.request(c, 'permission', request);
        await this.flush(c);
        const denied: DeniedRequest = { toolName: request.toolName, summary: request.summary, at: this.now().toISOString() };
        if (request.agentType !== undefined) denied.agentType = request.agentType;
        c.state.denied.push(denied);
        this.push(c, { kind: 'denied', data: { ...denied, by: 'policy' } });
        this.recordDenial(c, 'policy', request.toolName, request.agentType);
        return 'deny';
      },
      approveSpec: (request) => {
        c.lastSpec = request;
        return this.request(c, 'spec', request);
      },
      grantDirectory: (request) => this.request(c, 'grant', request),
      emit: (event) => {
        if (event.kind === 'denial') {
          const data: DeniedEventData = {
            toolName: event.toolName,
            summary: redactSecretLines(event.summary),
            at: this.now().toISOString(),
            by: 'runner',
            reason: redactSecretLines(event.reason),
          };
          if (event.agentType !== undefined) data.agentType = event.agentType;
          this.push(c, { kind: 'denied', data });
          this.recordDenial(c, 'guard', event.toolName, event.agentType, {
            reason: data.reason ?? '',
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
            ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
          });
        } else {
          const runner = event.kind === 'status' && event.message !== undefined ? { ...event, message: redactSecretLines(event.message) } : event;
          if (runner.kind === 'status' && runner.status === 'turnEnded') {
            // Requests are asked during a turn, so normally none is waiting here; if one is, it is what the page shows.
            if (c.queue.length === 0) c.state.awaitingReply = { lastMessage: runner.message ?? '', at: this.now().toISOString() };
          } else if (runner.kind === 'status' && runner.status === 'running') {
            delete c.state.awaitingReply;
          }
          this.push(c, { kind: 'status', data: { ...this.statusData(c), runner } });
        }
      },
    };
  }

  /**
   * Appends a runner line to the session's `events.jsonl`, after the ones
   * asked for before it. Before the session id is known, it waits.
   */
  private record(c: Creation, fields: RunnerLineFields): void {
    const session = c.state.sessionId;
    if (session === undefined) {
      c.unwritten.push(fields);
      return;
    }
    const event = runnerEvent(session, fields, this.now());
    c.writeChain = c.writeChain.then(() => appendEvent(this.options.sessionsDir, event).then(() => undefined)).catch(() => undefined);
  }

  /** Plan usage now, then every `usageEveryMs` until the creation finishes. A failed reading writes nothing. */
  private startUsage(c: Creation): void {
    const read = this.options.planUsage;
    if (read === undefined) return;
    const once = async () => {
      if (this.isFinished(c)) return;
      try {
        const usage = await read();
        if (usage !== undefined && !this.isFinished(c)) {
          this.record(c, { type: 'usage', fiveHour: usage.fiveHour, sevenDay: usage.sevenDay });
        }
      } catch {
        // Plan usage is a nice-to-have; the panel says it is not available.
      }
      if (c.state.usageReading === true) {
        // After the line is in the file, so the page never shows "not available" in between.
        await c.writeChain;
        await this.flush(c);
        delete c.state.usageReading;
        if (!this.isFinished(c)) this.pushStatus(c);
      }
    };
    void once();
    c.usageTimer = setInterval(() => void once(), this.options.usageEveryMs ?? 300_000);
    c.usageTimer.unref();
  }

  private recordProfile(c: Creation): void {
    const profile = c.profile;
    if (profile === undefined) return;
    this.record(c, {
      type: 'session.profile',
      profile: profile.name,
      model: profile.sessionModel,
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
    });
  }

  private recordDenial(
    c: Creation,
    by: DenialSource,
    tool: string,
    agentType: string | undefined,
    extra: { reason?: string; agentId?: string; toolUseId?: string } = {},
  ): void {
    this.record(c, {
      type: 'tool.denied',
      tool,
      by,
      ...(agentType === undefined ? {} : { agentType }),
      ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
      ...(extra.toolUseId === undefined ? {} : { toolUseId: extra.toolUseId }),
      // A reason may quote a path from the command; the file keeps no absolute path, as the panel shows none.
      ...(extra.reason === undefined || extra.reason === '' ? {} : { reason: hideAbsolutePaths(redactSecretLines(extra.reason)) }),
    });
  }

  private async request<K extends PendingKind>(c: Creation, kind: K, payload: PendingPayloads[K]): Promise<PendingResults[K]> {
    if (this.isFinished(c) || c.state.cancelling) return CANCEL_ANSWERS[kind];
    // Stream what the flow wrote before it asked, so the order is right.
    await this.flush(c);
    if (this.isFinished(c) || c.state.cancelling) return CANCEL_ANSWERS[kind];
    c.nextPending += 1;
    const pending = { id: `p${c.nextPending}`, kind, payload } as Pending;
    return new Promise<PendingResults[K]>((resolve) => {
      c.queue.push({ pending, resolve: resolve as (value: unknown) => void });
      if (c.queue.length === 1) this.activate(c);
    });
  }

  /** Shows the head of the queue to the user. */
  private activate(c: Creation): void {
    const head = c.queue[0];
    if (head === undefined) {
      if (c.state.status === 'waiting') {
        c.state.status = 'running';
        this.pushStatus(c);
      }
      return;
    }
    c.state.status = 'waiting';
    delete c.state.awaitingReply;
    this.pushStatus(c);
    this.push(c, { kind: head.pending.kind, data: { pendingId: head.pending.id, state: 'pending', payload: head.pending.payload } });
  }

  /** Resolves the head of the queue and shows the next one. */
  private settle(c: Creation, result: unknown, shown: unknown): void {
    const head = c.queue.shift();
    if (head === undefined) return;
    head.resolve(result);
    this.push(c, { kind: head.pending.kind, data: { pendingId: head.pending.id, state: 'answered', answer: shown } });
    this.activate(c);
  }

  /** Answers every queued request as a cancel would. */
  private settleAll(c: Creation): void {
    while (c.queue.length > 0) {
      const head = c.queue.shift() as QueuedRequest;
      const answer = CANCEL_ANSWERS[head.pending.kind];
      head.resolve(answer);
      this.push(c, { kind: head.pending.kind, data: { pendingId: head.pending.id, state: 'answered', answer } });
    }
    if (c.state.status === 'waiting') c.state.status = 'running';
  }

  private statusData(c: Creation): StatusEventData {
    const data: StatusEventData = { status: c.state.status };
    if (c.state.outcome !== undefined) data.outcome = c.state.outcome;
    if (c.state.sessionId !== undefined) data.sessionId = c.state.sessionId;
    if (c.state.cancelling) data.cancelling = true;
    return data;
  }

  private pushStatus(c: Creation): void {
    this.push(c, { kind: 'status', data: this.statusData(c) });
  }

  private push(c: Creation, item: { kind: StreamKind; data: unknown }): void {
    const event = { seq: c.buffer.length + 1, ts: this.now().toISOString(), ...item } as StreamEvent;
    c.buffer.push(event);
    for (const subscriber of [...c.subscribers]) subscriber.listener(event);
  }

  private schedulePoll(c: Creation): void {
    if (this.isFinished(c) || c.pollTimer !== undefined) return;
    c.pollTimer = setTimeout(() => {
      c.pollTimer = undefined;
      void this.flush(c).then(() => this.schedulePoll(c));
    }, this.pollMs);
    c.pollTimer.unref();
  }

  /** Reads `events.jsonl` and streams lines not seen yet. Calls are serialised. */
  private flush(c: Creation): Promise<void> {
    c.pollChain = c.pollChain.then(() => this.readNew(c)).catch(() => undefined);
    return c.pollChain;
  }

  private async readNew(c: Creation): Promise<void> {
    const sessionId = c.state.sessionId;
    if (sessionId === undefined || this.isFinished(c)) return;
    const file = sessionEventsFile(this.options.sessionsDir, sessionId);
    const outcome = this.pushLines(c, (await readEvents(file)).events);
    if (outcome === undefined) return;
    // One last read before the subscribers are closed: lines written just after the close
    // (runner lines still queued, a late hook line) reach the live panel too, so it matches
    // the panel rebuilt from the file.
    await c.writeChain;
    if (this.isFinished(c)) return;
    this.pushLines(c, (await readEvents(file)).events);
    this.finish(c, outcome);
  }

  /** Streams the lines after the ones consumed; returns the outcome of the first `session.finished` among them. */
  private pushLines(c: Creation, events: readonly SessionEvent[]): CreationOutcome | undefined {
    let outcome: CreationOutcome | undefined;
    for (const event of events.slice(c.consumed)) {
      c.consumed += 1;
      // Hook and runner lines leave the server projected: known fields only, targets and reasons redacted.
      // `id` is the line's position among the file's valid lines, as `GET /api/sessions/:id/events` gives it.
      if (event.source === 'hook') {
        this.push(c, { kind: 'hook', data: projectEvent(event, c.consumed) as unknown as HookEvent });
        continue;
      }
      if (event.source === 'runner') {
        this.push(c, { kind: 'runner', data: projectEvent(event, c.consumed) as unknown as RunnerLineEvent });
        continue;
      }
      this.push(c, { kind: 'flow', data: event });
      if ('step' in event) c.openStep = event.type === 'step.started' ? event.step : undefined;
      else if (event.type === 'session.finished') outcome ??= event.outcome ?? 'completed';
    }
    return outcome;
  }

  private finish(c: Creation, outcome: CreationOutcome): void {
    if (this.isFinished(c)) return;
    // Anything still waiting gets a cancel-like answer, so the runner never hangs.
    while (c.queue.length > 0) {
      const head = c.queue.shift() as QueuedRequest;
      head.resolve(CANCEL_ANSWERS[head.pending.kind]);
    }
    c.state.status = 'finished';
    c.state.outcome = outcome;
    c.state.finishedAt = this.now().toISOString();
    delete c.state.cancelling;
    delete c.state.awaitingReply;
    delete c.state.usageReading;
    for (const timer of [c.pollTimer, c.cancelTimer]) if (timer !== undefined) clearTimeout(timer);
    if (c.usageTimer !== undefined) clearInterval(c.usageTimer);
    c.usageTimer = undefined;
    c.pollTimer = undefined;
    c.cancelTimer = undefined;
    this.pushStatus(c);
    // The stream stays open until the runner is done: Claude Code writes `session.end` as it exits.
    if (c.runnerDone || c.handle === undefined) void this.closeStream(c);
    else if (!c.stopping) {
      c.graceTimer = setTimeout(() => void this.stopRunner(c), this.finishGraceMs);
      c.graceTimer.unref();
    }
  }

  /**
   * The end of a finished creation's stream: the lines written after the
   * close (runner lines still queued, the hook's `session.end` on exit) are
   * read and streamed, then the subscribers are closed. So the live panel
   * matches the panel rebuilt from the file.
   */
  private async closeStream(c: Creation): Promise<void> {
    if (c.streamClosed || c.closing !== undefined) return c.closing;
    c.closing = (async () => {
      const tail = async () => {
        await c.writeChain;
        const session = c.state.sessionId;
        if (session === undefined) return;
        try {
          this.pushLines(c, (await readEvents(sessionEventsFile(this.options.sessionsDir, session))).events);
        } catch {
          // Nothing more to stream.
        }
      };
      await (c.pollChain = c.pollChain.then(tail).catch(() => undefined));
      await new Promise((resolve) => setTimeout(resolve, this.tailMs).unref());
      await (c.pollChain = c.pollChain.then(tail).catch(() => undefined));
      c.streamClosed = true;
      const subscribers = [...c.subscribers];
      c.subscribers.clear();
      for (const subscriber of subscribers) subscriber.onEnd();
    })();
    return c.closing;
  }

  private async stopRunner(c: Creation): Promise<void> {
    c.stopping = true;
    if (c.graceTimer !== undefined) clearTimeout(c.graceTimer);
    if (c.runnerDone || c.handle === undefined) return;
    await c.handle.stop().catch(() => undefined);
  }

  private async onRunnerDone(c: Creation, outcome: RunnerOutcome): Promise<void> {
    c.runnerDone = true;
    if (c.graceTimer !== undefined) clearTimeout(c.graceTimer);
    if (outcome.kind === 'failed') c.state.error = outcome.error;
    await this.flush(c);
    if (this.isFinished(c)) {
      void this.closeStream(c);
      return;
    }
    // The server is ending it (stop or cancel fallback) and writes the end itself.
    if (c.stopping) return;
    // The runner ended without closing the flow: the session is interrupted.
    if (c.state.sessionId !== undefined) {
      const end: HookEvent = {
        v: EVENT_FORMAT,
        ts: this.now().toISOString(),
        session: c.state.sessionId,
        source: 'hook',
        type: 'session.end',
        reason: outcome.kind === 'failed' ? 'runner_failed' : 'runner_exit',
      };
      await appendEvent(this.options.sessionsDir, end).catch(() => undefined);
      await this.flush(c);
    }
    this.finish(c, 'interrupted');
  }

  /** The flow did not close after a cancel: stop the runner and write the close. */
  private async cancelFallback(c: Creation): Promise<void> {
    if (this.isFinished(c)) return;
    await this.stopRunner(c);
    await this.flush(c);
    if (this.isFinished(c)) return;
    const session = c.state.sessionId;
    if (session !== undefined) {
      const { sessionsDir } = this.options;
      try {
        if (c.openStep !== undefined) await appendEvent(sessionsDir, flowEvent(session, c.openStep, 'finished', 'skipped', this.now()));
        await appendEvent(sessionsDir, sessionLifecycleEvent(session, 'finished', 'cancelled', this.now()));
      } catch {
        // Finished below either way.
      }
      await this.flush(c);
    }
    this.finish(c, 'cancelled');
  }
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BriefstackError } from '../errors.js';
import {
  EVENT_FORMAT,
  appendEvent,
  flowEvent,
  readEvents,
  sessionEventsFile,
  sessionLifecycleEvent,
  type FlowEvent,
  type FlowStep,
  type HookEvent,
  type SessionLifecycleEvent,
  type SessionOutcome,
} from '../events/index.js';
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
  denied: DeniedRequest[];
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
    | { kind: PendingKind; data: PendingEventData }
    | { kind: 'status'; data: StatusEventData }
    | { kind: 'denied'; data: DeniedEventData }
  );

export type StreamKind = StreamEvent['kind'];

export interface CreationManagerOptions {
  runner: CreationRunner;
  sessionsDir: string;
  /** Read when a creation starts; it applies to that creation until it ends. */
  policy: () => PermissionPolicy;
  /** The active usage profile's session model and effort. */
  profile: () => RunnerProfile | Promise<RunnerProfile>;
  now?: () => Date;
  /** How often `events.jsonl` is read. Default 300 ms. */
  pollMs?: number;
  /** After a cancel, how long the flow has to close the session before the server does. Default 60 s. */
  cancelTimeoutMs?: number;
  /** After `session.finished`, how long the runner has to end by itself before it is stopped. Default 30 s. */
  finishGraceMs?: number;
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
  openStep?: FlowStep | undefined;
  pollTimer?: NodeJS.Timeout | undefined;
  pollChain: Promise<void>;
  cancelTimer?: NodeJS.Timeout | undefined;
  graceTimer?: NodeJS.Timeout | undefined;
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

  constructor(options: CreationManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? 300;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 60_000;
    this.finishGraceMs = options.finishGraceMs ?? 30_000;
  }

  /** Starts a creation. Throws `creation.busy` while another one is active. */
  async create(idea: string): Promise<CreationState> {
    const active = [...this.creations.values()].find((c) => c.state.status !== 'finished');
    if (active !== undefined) throw new BriefstackError('creation.busy', { active: active.state.id });

    const policy = this.options.policy();
    const c: Creation = {
      state: {
        id: randomUUID(),
        idea,
        profile: '',
        policy,
        status: 'running',
        denied: [],
        startedAt: this.now().toISOString(),
      },
      runnerDone: false,
      stopping: false,
      queue: [],
      nextPending: 0,
      buffer: [],
      subscribers: new Set(),
      consumed: 0,
      pollChain: Promise.resolve(),
    };
    // Registered before any await, so a second create sees it.
    this.creations.set(c.state.id, c);

    try {
      const profile = await this.options.profile();
      c.state.profile = profile.name;
      c.handle = this.options.runner.start({
        creationId: c.state.id,
        idea,
        profile,
        sessionsDir: this.options.sessionsDir,
        policy,
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
    if (this.isFinished(c)) {
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
      requestPermission: async (request) => {
        if (c.state.policy !== 'unattended') return this.request(c, 'permission', request);
        await this.flush(c);
        const denied: DeniedRequest = { toolName: request.toolName, summary: request.summary, at: this.now().toISOString() };
        if (request.agentType !== undefined) denied.agentType = request.agentType;
        c.state.denied.push(denied);
        this.push(c, { kind: 'denied', data: { ...denied, by: 'policy' } });
        return 'deny';
      },
      approveSpec: (request) => this.request(c, 'spec', request),
      grantDirectory: (request) => this.request(c, 'grant', request),
      emit: (event) => {
        if (event.kind === 'denial') {
          const data: DeniedEventData = {
            toolName: event.toolName,
            summary: event.summary,
            at: this.now().toISOString(),
            by: 'runner',
            reason: event.reason,
          };
          if (event.agentType !== undefined) data.agentType = event.agentType;
          this.push(c, { kind: 'denied', data });
        } else {
          this.push(c, { kind: 'status', data: { ...this.statusData(c), runner: event } });
        }
      },
    };
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
    const { events } = await readEvents(sessionEventsFile(this.options.sessionsDir, sessionId));
    for (const event of events.slice(c.consumed)) {
      c.consumed += 1;
      if (event.source === 'hook') {
        this.push(c, { kind: 'hook', data: event });
        continue;
      }
      this.push(c, { kind: 'flow', data: event });
      if ('step' in event) c.openStep = event.type === 'step.started' ? event.step : undefined;
      else if (event.type === 'session.finished') {
        this.finish(c, event.outcome ?? 'completed');
        return;
      }
    }
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
    for (const timer of [c.pollTimer, c.cancelTimer]) if (timer !== undefined) clearTimeout(timer);
    c.pollTimer = undefined;
    c.cancelTimer = undefined;
    this.pushStatus(c);
    const subscribers = [...c.subscribers];
    c.subscribers.clear();
    for (const subscriber of subscribers) subscriber.onEnd();
    if (!c.runnerDone && !c.stopping && c.handle !== undefined) {
      c.graceTimer = setTimeout(() => void this.stopRunner(c), this.finishGraceMs);
      c.graceTimer.unref();
    }
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
    // The server is ending it (stop or cancel fallback) and writes the end itself.
    if (this.isFinished(c) || c.stopping) return;
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

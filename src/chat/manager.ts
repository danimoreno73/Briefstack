import { randomUUID } from 'node:crypto';
import { BriefstackError } from '../errors.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { redactSecretLines } from '../validate/secrets.js';
import type { ChatStore, ChatStoreState, ChatThreadRecord } from './store.js';
import { ChatToolError, errorText, findChatTool, parseArgs, resultText, type ChatToolContext, type ToolOutcome } from './tools.js';
import type {
  ChatMessage,
  ChatNotice,
  ChatRunner,
  ChatRunnerEvent,
  ChatSession,
  ChatSource,
  ChatStatus,
  ChatStreamEvent,
  ChatThreadInfo,
  ChatView,
  Confirmation,
  ConfirmationState,
  ToolReply,
} from './types.js';

/**
 * The global chat (BRIEF-phase-4 §3.1): one active thread, its history,
 * the chat session, and the confirmations of its action tools.
 *
 * Security rules this class keeps (BRIEF-phase-4 §4):
 * - an action runs only after `confirm()` with `confirm`, which only the
 *   token-protected route calls; a tool result alone never performs one;
 * - one confirmation waits at a time, and at most `maxProposals` cards are
 *   shown per `proposalWindowMs`, so a loop of proposals cannot flood the page;
 * - every text kept or streamed, and every message sent to the model, has
 *   been through the secret redactor.
 */

export interface ChatManagerOptions {
  store: ChatStore;
  runner: ChatRunner;
  tools: ChatToolContext;
  /** The chat's model and effort from the active usage profile, read when a session starts. */
  profile(): Promise<{ model: string; effort: string }>;
  now?: () => Date;
  /** A session with nothing to do for this long is closed; the next message resumes it. Default 10 minutes. */
  idleMs?: number;
  /** Default 10 cards per 10 minutes. */
  maxProposals?: number;
  proposalWindowMs?: number;
}

type Listener = (event: ChatStreamEvent) => void;

interface Waiting {
  confirmation: Confirmation;
  messageId: number;
  resolve(state: 'confirmed' | 'declined' | 'expired'): void;
}

const TITLE_LENGTH = 60;

export class ChatManager {
  private state: ChatStoreState = { v: 1, threads: [] };
  private thread!: ChatThreadRecord;
  private messages: ChatMessage[] = [];
  private session: ChatSession | undefined;
  private status: ChatStatus = 'idle';
  private waiting: Waiting | undefined;
  private proposals: number[] = [];
  private readonly buffer: ChatStreamEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private writes: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  /** The last message the user sent, sent again if a resume fails. */
  private lastUserText: string | undefined;
  private readonly now: () => Date;

  private constructor(private readonly options: ChatManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Loads the history and the active thread (a new one when there is none). */
  static async open(options: ChatManagerOptions): Promise<ChatManager> {
    const manager = new ChatManager(options);
    await manager.load();
    return manager;
  }

  private async load(): Promise<void> {
    this.state = await this.options.store.loadState();
    const active = this.state.threads.find((thread) => thread.id === this.state.active && thread.archivedAt === undefined);
    if (active === undefined) {
      this.thread = this.newThreadRecord();
      this.state.threads.push(this.thread);
      this.state.active = this.thread.id;
      await this.options.store.saveState(this.state);
      this.messages = [];
    } else {
      this.thread = active;
      this.messages = await this.options.store.readThread(active.id);
      // A confirmation left open when the server stopped can no longer run.
      for (const message of this.messages) {
        if (message.confirmation?.state === 'pending') this.updateConfirmation(message, 'expired');
      }
    }
  }

  private newThreadRecord(): ChatThreadRecord {
    const at = this.now().toISOString();
    return { id: randomUUID(), title: '', createdAt: at, updatedAt: at };
  }

  private info(thread: ChatThreadRecord): ChatThreadInfo {
    const { sdkSessionId: _session, ...info } = thread;
    void _session;
    return info;
  }

  /** The active thread as the page shows it; `seq` is where its stream continues. */
  async view(): Promise<ChatView & { seq: number }> {
    let model: { model: string; effort: string } | undefined;
    try {
      model = await this.options.profile();
    } catch {
      model = undefined;
    }
    return {
      thread: this.info(this.thread),
      messages: structuredClone(this.messages),
      status: this.status,
      ...(this.waiting === undefined ? {} : { pending: structuredClone(this.waiting.confirmation) }),
      ...(model === undefined ? {} : { model }),
      seq: this.buffer.length,
    };
  }

  threads(): ChatThreadInfo[] {
    return [...this.state.threads].reverse().map((thread) => this.info(thread));
  }

  /** Any thread, archived or not, read-only. */
  async readThread(id: string): Promise<{ thread: ChatThreadInfo; messages: ChatMessage[] }> {
    const thread = this.state.threads.find((candidate) => candidate.id === id);
    if (thread === undefined) throw new BriefstackError('chat.threadNotFound', { id });
    const messages = thread.id === this.thread.id ? structuredClone(this.messages) : await this.options.store.readThread(id);
    return { thread: this.info(thread), messages };
  }

  // ---- stream

  subscribe(fromSeq: number, listener: Listener): () => void {
    for (const event of this.buffer) if (event.seq > fromSeq) listener(event);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private push(event: Omit<ChatStreamEvent, 'seq' | 'ts'>): void {
    const full = { ...event, seq: this.buffer.length + 1, ts: this.now().toISOString() } as ChatStreamEvent;
    this.buffer.push(full);
    for (const listener of [...this.listeners]) listener(full);
  }

  private setStatus(status: ChatStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.push({ kind: 'status', data: { status } });
  }

  /** Keeps a message (in order, one write at a time) and streams it. */
  private record(message: ChatMessage): void {
    const threadId = this.thread.id;
    const index = this.messages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) this.messages[index] = message;
    else this.messages.push(message);
    this.writes = this.writes.then(() => this.options.store.append(threadId, message)).catch(() => undefined);
    this.push({ kind: 'message', data: structuredClone(message) });
  }

  private add(message: Omit<ChatMessage, 'id' | 'ts'>): ChatMessage {
    const full: ChatMessage = { id: (this.messages.at(-1)?.id ?? 0) + 1, ts: this.now().toISOString(), ...message };
    this.record(full);
    return full;
  }

  private notice(notice: ChatNotice, detail?: string): void {
    this.add({ role: 'notice', notice, ...(detail === undefined ? {} : { detail: hideAbsolutePaths(redactSecretLines(detail)).slice(0, 500) }) });
  }

  private async saveThread(patch: Partial<ChatThreadRecord>): Promise<void> {
    Object.assign(this.thread, patch, { updatedAt: this.now().toISOString() });
    this.writes = this.writes.then(() => this.options.store.saveState(this.state)).catch(() => undefined);
    await this.writes;
  }

  // ---- talking

  /** Sends the user's message. Refused with `chat.busy` while the chat is still answering. */
  async send(raw: string): Promise<void> {
    if (this.status === 'thinking') throw new BriefstackError('chat.busy', {});
    const text = redactSecretLines(raw.trim());
    this.add({ role: 'user', text });
    if (this.thread.title === '') await this.saveThread({ title: text.replace(/\s+/g, ' ').slice(0, TITLE_LENGTH) });
    else await this.saveThread({});
    this.setStatus('thinking');
    this.clearIdle();
    this.lastUserText = text;
    let session: ChatSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      // The session could not start (for example the usage profile does not load): say so, stay usable.
      this.notice('sessionError', errorText(error));
      this.setStatus('idle');
      return;
    }
    session.send(text);
  }

  private async ensureSession(): Promise<ChatSession> {
    if (this.session !== undefined) return this.session;
    const profile = await this.options.profile();
    const resume = this.thread.sdkSessionId;
    const threadId = this.thread.id;
    // The runner may emit before `start` returns; until then nothing it says is taken.
    const holder: { session?: ChatSession } = {};
    const ours = () => holder.session !== undefined && this.session === holder.session && this.thread.id === threadId;
    const session = this.options.runner.start({
      ...(resume === undefined ? {} : { resume }),
      model: profile.model,
      effort: profile.effort,
      execute: (name, args) => this.execute(name, args),
      emit: (event) => {
        if (ours()) this.onRunnerEvent(event);
      },
    });
    holder.session = session;
    this.session = session;
    const started = session;
    void started.done.then(() => {
      if (this.session !== started) return;
      this.session = undefined;
      this.clearIdle();
      if (this.status === 'thinking') {
        this.expireWaiting();
        this.setStatus('idle');
      }
    });
    return session;
  }

  private onRunnerEvent(event: ChatRunnerEvent): void {
    switch (event.kind) {
      case 'session':
        if (this.thread.sdkSessionId !== event.sessionId) void this.saveThread({ sdkSessionId: event.sessionId });
        break;
      case 'text': {
        const text = redactSecretLines(event.text.trim());
        if (text !== '') this.add({ role: 'assistant', text });
        break;
      }
      case 'turnEnd':
        this.setStatus('idle');
        this.armIdle();
        break;
      case 'resumeFailed': {
        // The model context could not be restored: a new session, the old messages stay readable.
        const pendingText = this.lastUserText;
        const failed = this.session;
        this.session = undefined;
        void failed?.stop();
        this.notice('resumeFailed');
        delete this.thread.sdkSessionId;
        void this.saveThread({}).then(async () => {
          if (pendingText === undefined) {
            this.setStatus('idle');
            return;
          }
          (await this.ensureSession()).send(pendingText);
        });
        break;
      }
      case 'error': {
        const failed = this.session;
        this.session = undefined;
        void failed?.stop();
        this.expireWaiting();
        this.notice('sessionError', event.message);
        this.setStatus('idle');
        break;
      }
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.waiting !== undefined) return;
    this.idleTimer = setTimeout(() => {
      const idle = this.session;
      this.session = undefined;
      void idle?.stop();
    }, this.options.idleMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // ---- tools

  /** Runs one tool call for the session. Errors come back as tool errors the model can read. */
  async execute(name: string, args: unknown): Promise<ToolReply> {
    const reply = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
    const definition = findChatTool(name);
    if (definition === undefined) return reply(`There is no tool ${name}.`, true);
    let parsed: Record<string, unknown>;
    try {
      parsed = parseArgs(definition, args);
    } catch (error) {
      return reply(errorText(error), true);
    }
    const summary = redactSecretLines((definition.summary as (input: unknown) => string)(parsed)).slice(0, 200);

    if (definition.kind === 'read') {
      try {
        const outcome = await (definition.run as (ctx: ChatToolContext, input: unknown) => Promise<ToolOutcome>)(this.options.tools, parsed);
        this.add({ role: 'tool', tool: { name, summary, sources: outcome.sources.slice(0, 20) } });
        return reply(resultText(outcome, this.options.tools.pathEnv.homedir));
      } catch (error) {
        const text = errorText(error);
        this.add({ role: 'tool', tool: { name, summary, sources: [], error: text } });
        return reply(text, true);
      }
    }

    // An action: one card at a time, a limited number per window, and nothing runs without a confirmation.
    if (this.waiting !== undefined) {
      return reply('Another proposal is waiting for the user’s answer. Wait for it before proposing anything else.', true);
    }
    const now = this.now().getTime();
    const window = this.options.proposalWindowMs ?? 10 * 60_000;
    this.proposals = this.proposals.filter((at) => now - at < window);
    if (this.proposals.length >= (this.options.maxProposals ?? 10)) {
      return reply('Too many proposals in a short time. Stop proposing actions and tell the user.', true);
    }
    let proposal;
    try {
      proposal = await definition.propose(this.options.tools, parsed);
    } catch (error) {
      const text = errorText(error);
      this.add({ role: 'tool', tool: { name, summary, sources: [], error: text } });
      return reply(text, true);
    }
    this.proposals.push(now);
    const confirmation: Confirmation = { id: randomUUID(), tool: name, card: proposal.card, state: 'pending' };
    const message = this.add({ role: 'confirmation', confirmation });
    this.clearIdle();
    const decision = await new Promise<'confirmed' | 'declined' | 'expired'>((resolve) => {
      this.waiting = { confirmation, messageId: message.id, resolve };
    });
    this.waiting = undefined;
    if (decision === 'declined') {
      this.updateConfirmation(message, 'declined');
      return reply('The user declined. Nothing was done.');
    }
    if (decision === 'expired') {
      this.updateConfirmation(message, 'expired');
      return reply('The proposal expired before the user answered. Nothing was done.', true);
    }
    try {
      const outcome = await proposal.perform();
      this.updateConfirmation(message, 'confirmed', undefined, outcome.sources);
      return reply(resultText({ ...outcome, data: { confirmedByUser: true, result: outcome.data } }, this.options.tools.pathEnv.homedir));
    } catch (error) {
      const text = errorText(error);
      this.updateConfirmation(message, 'failed', text);
      return reply(`The user confirmed, but it failed: ${text}`, true);
    }
  }

  private updateConfirmation(message: ChatMessage, state: ConfirmationState, result?: string, sources?: ChatSource[]): void {
    if (message.confirmation === undefined) return;
    const confirmation: Confirmation = {
      ...message.confirmation,
      state,
      ...(result === undefined ? {} : { result: redactSecretLines(result).slice(0, 500) }),
      ...(sources === undefined ? {} : { sources: sources.slice(0, 5) }),
    };
    this.record({ ...message, confirmation });
  }

  /**
   * The user's answer to the waiting card, from the browser. The action runs
   * on `confirm` only, and only for the card that is waiting now.
   */
  confirm(confirmationId: string, decision: 'confirm' | 'decline'): void {
    const waiting = this.waiting;
    if (waiting === undefined || waiting.confirmation.id !== confirmationId) throw new BriefstackError('chat.noConfirmation', { id: confirmationId });
    this.waiting = undefined;
    waiting.resolve(decision === 'confirm' ? 'confirmed' : 'declined');
  }

  private expireWaiting(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve('expired');
  }

  // ---- threads

  /** "New chat": the current thread is archived (read-only) and an empty one becomes active. */
  async newChat(): Promise<void> {
    this.expireWaiting();
    const old = this.session;
    this.session = undefined;
    this.clearIdle();
    await old?.stop();
    this.setStatus('idle');
    await this.writes;
    this.thread.archivedAt = this.now().toISOString();
    this.thread = this.newThreadRecord();
    this.state.threads.push(this.thread);
    this.state.active = this.thread.id;
    this.messages = [];
    this.lastUserText = undefined;
    await this.saveThread({});
    this.push({ kind: 'thread', data: { threadId: this.thread.id } });
  }

  async shutdown(): Promise<void> {
    this.expireWaiting();
    this.clearIdle();
    const old = this.session;
    this.session = undefined;
    await old?.stop();
    await this.writes;
    this.listeners.clear();
  }
}

export { ChatToolError };

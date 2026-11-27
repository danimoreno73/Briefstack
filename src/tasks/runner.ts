import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, EVENT_FORMAT, isSessionId, MAX_TARGET_LENGTH, sessionLifecycleEvent, TASK_SESSION_MARKER, type EventTarget, type HookEvent, type HookEventType, type SessionOutcome } from '../events/index.js';
import { CodexDelegate, type CodexSession } from '../codex/tool.js';
import type { Effort } from '../models.js';
import type { QuestionRequest, QuestionResult } from '../creation/types.js';
import type { TaskApprovals } from './shell.js';
import type { ReserveProvider } from '../providers/config.js';
import { branchOf, type ClaudeUsage, type TaskCodexCall } from './types.js';

/**
 * A task's session runner (BRIEF-phase-7 §3.2): the SDK one and a fake one
 * for every UI and API test. One runner run is one round of the task.
 */

export type TaskRunnerEvent =
  | { kind: 'status'; status: 'starting' | 'running' | 'turnEnded' | 'stopping' | 'error'; message?: string }
  | { kind: 'agent'; phase: 'started' | 'stopped'; agentType: string; agentId?: string }
  | { kind: 'denial'; toolName: string; summary: string; agentType?: string; agentId?: string; toolUseId?: string; reason: string }
  | { kind: 'effort'; level: string; requested?: string }
  /** Claude's tokens so far in the round's session (each result message carries the running total). */
  | { kind: 'usage'; usage: ClaudeUsage };

export interface TaskRunnerIO {
  askQuestions(request: QuestionRequest): Promise<QuestionResult>;
  emit(event: TaskRunnerEvent): void;
  /** Saves one `delegate_to_codex` call in the round's record (phase 8). */
  recordCodex?(call: TaskCodexCall): Promise<void>;
}

export interface TaskRunnerStartOptions {
  taskId: string;
  /** The project's slug, for the session folder's marker. */
  project: string;
  round: number;
  /** The whole first message of the round (`roundPrompt`). */
  prompt: string;
  worktree: string;
  model: string;
  effort: Effort;
  sessionsDir: string;
  /** The project's own skills: the SDK `skills` option and the guard's list. */
  skills: readonly string[];
  /** The project's deny and ask rules (they only restrict). */
  restrictions: { deny: string[]; ask: string[] };
  /** `<home>/tasks/<id>/guard.json`. */
  rulesFile: string;
  /** `<home>/tasks/<id>/approvals/`. */
  approvalsDir: string;
  /** The task's shell and web approvals: kept across its rounds, asked through the manager's dialog. */
  approvals: TaskApprovals;
  /** Set when the round offers `delegate_to_codex` (phase 8): the Settings switch is on and the last check passed. */
  codex?: CodexSession;
  /**
   * A build runs this round (phase 9): nobody watches it. Questions are
   * refused with `UNATTENDED_QUESTION`, and a denied command or request is
   * explained with `UNATTENDED_DENIED` instead of "the user did not allow".
   */
  unattended?: true;
  /**
   * A build's round past the usage threshold runs on this reserve provider
   * (phase 12): its environment, its model, permission mode `default`, no
   * effort. Its key is read when the round starts, by the runner only.
   */
  provider?: ReserveProvider;
  io: TaskRunnerIO;
}

/** What a build's session reads when it tries to ask a question (phase 9). */
export const UNATTENDED_QUESTION = 'Nobody can answer questions during a build. Decide yourself, following the task and its "done when", and say what you decided in your final message.';
/** What a build's session reads when a command or request is denied (phase 9). */
export const UNATTENDED_DENIED = 'Denied: during a build only the exact commands approved at its start can run, and web requests are not allowed. Nobody was asked. Go on without it, or use an approved command.';

/**
 * Claude's tokens from an SDK result message: `modelUsage` summed over its
 * models (the field the SDK documents for token accounting), or, without
 * it, the main loop's `usage`. `undefined` when the message carries neither
 * or the numbers are not counts.
 */
export function claudeUsageOf(message: unknown): ClaudeUsage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
  const { modelUsage, usage } = message as { modelUsage?: unknown; usage?: unknown };
  const fromModels = (): ClaudeUsage | undefined => {
    if (typeof modelUsage !== 'object' || modelUsage === null || Object.keys(modelUsage).length === 0) return undefined;
    const total: ClaudeUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) return undefined;
      const fields = entry as Record<string, unknown>;
      const input = count(fields.inputTokens);
      const output = count(fields.outputTokens);
      if (input === undefined || output === undefined) return undefined;
      total.input += input;
      total.output += output;
      total.cacheRead += count(fields.cacheReadInputTokens) ?? 0;
      total.cacheCreation += count(fields.cacheCreationInputTokens) ?? 0;
    }
    return total;
  };
  const models = fromModels();
  if (models !== undefined) return models;
  // Without a usable `modelUsage`: the main loop's `usage`, which the SDK gives per turn (so a round with several
  // turns counts only its last one; review of step 33, part A).
  if (typeof usage === 'object' && usage !== null) {
    const fields = usage as Record<string, unknown>;
    const input = count(fields.input_tokens);
    const output = count(fields.output_tokens);
    if (input === undefined || output === undefined) return undefined;
    return { input, output, cacheRead: count(fields.cache_read_input_tokens) ?? 0, cacheCreation: count(fields.cache_creation_input_tokens) ?? 0 };
  }
  return undefined;
}

/** Tokens without the cache (input + output: the main figure) and with it (plus cache reads and writes). */
export function claudeTokens(usage: ClaudeUsage): { noCache: number; withCache: number } {
  const noCache = usage.input + usage.output;
  return { noCache, withCache: noCache + usage.cacheRead + usage.cacheCreation };
}

export type TaskRunnerOutcome = { kind: 'ended'; summary?: string } | { kind: 'stopped' } | { kind: 'failed'; error: string };

export interface TaskRunnerHandle {
  /** Resolves once the Claude Code session id is known. */
  sessionId: Promise<string>;
  /** The user cancelled: the guard denies everything from now on. */
  requestCancel(): void;
  /** The user's free-text reply after a turn that ended waiting for text. */
  sendMessage(text: string): void;
  /** The round's work is done (the turn ended with nothing asked): end the session. */
  finish(): void;
  stop(): Promise<void>;
  done: Promise<TaskRunnerOutcome>;
}

export interface TaskRunner {
  start(options: TaskRunnerStartOptions): TaskRunnerHandle;
}

/**
 * The first message of a round. The task's text and a request for changes
 * are the user's words; everything else is fixed. The closing summary the
 * session writes is shown on the proposal page as data.
 */
export function roundPrompt(input: { description: string; round: number; changes?: string; lang: 'en' | 'es' }): string {
  const lines = [
    'You are working on a task in an existing project, in a separate copy of it (a git worktree). Your changes are reviewed by the user as a diff before anything reaches the project.',
    'Only change files inside this folder. Every shell command and web request asks the user first; prefer reading and editing files. Do not commit: briefstack commits your changes when you finish.',
    `Write your final message to the user in ${input.lang === 'es' ? 'Spanish' : 'English'}: a short summary of what you changed and anything the user should check.`,
    '',
    'The task:',
    input.description,
  ];
  if (input.round > 1 && input.changes !== undefined) {
    lines.push('', `This is round ${input.round}. The changes of the earlier rounds are already in this folder, committed. The user reviewed them and asks for these changes:`, input.changes);
  }
  return lines.join('\n');
}

/** The round's `delegate_to_codex` calls, when it offers the tool: Codex in the worktree, on the task's branch, each call recorded. */
export function codexDelegateFor(options: TaskRunnerStartOptions, env: Readonly<Record<string, string | undefined>>): CodexDelegate | undefined {
  if (options.codex === undefined) return undefined;
  return new CodexDelegate({
    session: options.codex,
    worktree: options.worktree,
    branch: branchOf(options.taskId),
    env,
    record: (call) => options.io.recordCodex?.(call) ?? Promise.resolve(),
  });
}

/** What a task's session folder holds besides `events.jsonl`, so the sessions list can tell a task from a creation. */
export const TASK_MARKER_FILE = TASK_SESSION_MARKER;

export interface TaskMarker {
  v: 1;
  taskId: string;
  project: string;
  round: number;
}

/** Opens a task session's folder: the marker and `session.started`. */
export async function openTaskSession(sessionsDir: string, session: string, marker: Omit<TaskMarker, 'v'>, now: Date = new Date()): Promise<void> {
  if (!isSessionId(session)) return;
  const folder = path.join(sessionsDir, session);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, TASK_MARKER_FILE), `${JSON.stringify({ v: 1, ...marker })}\n`, 'utf8');
  await appendEvent(sessionsDir, sessionLifecycleEvent(session, 'started', undefined, now));
}

/** Closes a task session's folder with `session.finished`. */
export async function closeTaskSession(sessionsDir: string, session: string, outcome: SessionOutcome, now: Date = new Date()): Promise<void> {
  if (!isSessionId(session)) return;
  await appendEvent(sessionsDir, sessionLifecycleEvent(session, 'finished', outcome, now));
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
const AGENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/;
const PATH_FIELDS: Readonly<Record<string, string>> = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', Glob: 'path', Grep: 'path' };

/** A tool call's target in a task: a path relative to the worktree, or `outside`. Never a command, query or address. */
export function workTarget(tool: string, input: unknown, worktree: string): EventTarget | undefined {
  const field = PATH_FIELDS[tool];
  if (field === undefined) return undefined;
  const value = (typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[field] : undefined) as unknown;
  const given = typeof value === 'string' && value !== '' ? value : tool === 'Glob' || tool === 'Grep' ? worktree : undefined;
  if (given === undefined) return undefined;
  const relative = path.relative(path.resolve(worktree), path.resolve(worktree, given));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { root: 'outside' };
  const shown = relative.split(path.sep).join('/');
  return { root: 'work', path: shown.length <= MAX_TARGET_LENGTH ? (shown === '' ? '.' : shown) : `…${shown.slice(shown.length - MAX_TARGET_LENGTH + 1)}` };
}

/** One hook line of a task session, in the format `scripts/hook-event.mjs` writes for creations (docs/events.md). */
export function taskHookEvent(
  session: string,
  type: HookEventType,
  fields: { agentId?: string | undefined; agentType?: string | undefined; tool?: string | undefined; toolUseId?: string | undefined; target?: EventTarget | undefined; effort?: string | undefined; reason?: string | undefined },
  now: Date = new Date(),
): HookEvent {
  const event: HookEvent = { v: EVENT_FORMAT, ts: now.toISOString(), session, source: 'hook', type };
  if (fields.agentId !== undefined && TOKEN_RE.test(fields.agentId)) event.agentId = fields.agentId;
  if (fields.agentType !== undefined && AGENT_TYPE_RE.test(fields.agentType)) event.agentType = fields.agentType;
  if (fields.tool !== undefined && TOKEN_RE.test(fields.tool)) event.tool = fields.tool;
  if (fields.toolUseId !== undefined && TOKEN_RE.test(fields.toolUseId)) event.toolUseId = fields.toolUseId;
  if (fields.target !== undefined) event.target = fields.target;
  if (fields.effort !== undefined && TOKEN_RE.test(fields.effort)) event.effort = fields.effort;
  if (fields.reason !== undefined && /^[a-z_]{1,32}$/.test(fields.reason)) event.reason = fields.reason;
  return event;
}

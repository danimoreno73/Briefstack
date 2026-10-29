import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, EVENT_FORMAT, isSessionId, MAX_TARGET_LENGTH, sessionLifecycleEvent, type EventTarget, type HookEvent, type HookEventType, type SessionOutcome } from '../events/index.js';
import type { Effort } from '../models.js';
import type { QuestionRequest, QuestionResult } from '../creation/types.js';
import type { TaskApprovals } from './shell.js';

/**
 * A task's session runner (BRIEF-phase-7 §3.2): the SDK one and a fake one
 * for every UI and API test. One runner run is one round of the task.
 */

export type TaskRunnerEvent =
  | { kind: 'status'; status: 'starting' | 'running' | 'turnEnded' | 'stopping' | 'error'; message?: string }
  | { kind: 'agent'; phase: 'started' | 'stopped'; agentType: string; agentId?: string }
  | { kind: 'denial'; toolName: string; summary: string; agentType?: string; agentId?: string; toolUseId?: string; reason: string }
  | { kind: 'effort'; level: string; requested?: string };

export interface TaskRunnerIO {
  askQuestions(request: QuestionRequest): Promise<QuestionResult>;
  emit(event: TaskRunnerEvent): void;
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
  io: TaskRunnerIO;
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

/** What a task's session folder holds besides `events.jsonl`, so the sessions list can tell a task from a creation. */
export const TASK_MARKER_FILE = 'task.json';

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

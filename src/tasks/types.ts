import { z } from 'zod';
import { EFFORT_LEVELS } from '../models.js';
import { SLUG_RE } from '../spec/schema.js';

/**
 * A task in an existing project (BRIEF-phase-7): one record per task in
 * `<home>/tasks/<id>/task.json`, its worktree in `<home>/tasks/<id>/work/`
 * on the branch `briefstack/task-<id>`.
 */

export const TASK_ID_RE = /^[a-z0-9]{6,12}-[a-f0-9]{4}$/;

/**
 * - `running`: a round's session is working (or waiting for the user).
 * - `checking`: the session ended and the server commits and validates the
 *   round; or, from a proposal (`reviewed` set), the declared checks the
 *   user asked for run.
 * - `proposal`: the change waits on the proposal page.
 * - `applied`: one commit on the default branch; the worktree is gone.
 * - `reverted`: the applied commit was reverted.
 * - `discarded`: the branch and the worktree were deleted.
 * - `failed`, `cancelled`, `interrupted`: the round ended without a
 *   proposal; the worktree stays until the user discards it or asks for a
 *   new round.
 */
export const TASK_STATES = ['running', 'checking', 'proposal', 'applied', 'reverted', 'discarded', 'failed', 'cancelled', 'interrupted'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States in which the task has a worktree and a branch: the project is taken. */
export const OPEN_TASK_STATES: readonly TaskState[] = ['running', 'checking', 'proposal', 'failed', 'cancelled', 'interrupted'];
/** States in which a session or the checks run: they count against the active-sessions limit. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['running', 'checking'];

export const isOpenTask = (state: TaskState): boolean => OPEN_TASK_STATES.includes(state);
export const isActiveTask = (state: TaskState): boolean => ACTIVE_TASK_STATES.includes(state);

export const branchOf = (id: string): string => `briefstack/task-${id}`;

const roundSchema = z.object({
  /** 1, 2, 3…: the first round is the task's text, each later one a request for changes. */
  n: z.int().min(1),
  text: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** The Claude Code session of the round (its folder in the sessions folder: the panel). */
  sessionId: z.string().optional(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
  /** The commit the server made on the task's branch at the end of the round; absent when nothing changed. */
  commit: z.string().optional(),
  /** The session's closing text, redacted: data, never instructions. */
  summary: z.string().optional(),
  error: z.string().optional(),
});
export type TaskRound = z.infer<typeof roundSchema>;

const checkResultSchema = z.object({
  command: z.string(),
  /** `null` when the command did not end by itself (timeout) or could not start. */
  exitCode: z.int().nullable(),
  timedOut: z.boolean(),
  /** Redacted, cut to a size the page can show. */
  output: z.string(),
  durationMs: z.int().min(0),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

const validationSchema = z.object({
  kind: z.enum(['outsideWorktree', 'settingsOrHooks', 'secret', 'personalPath', 'hiddenLine']),
  /** `error` blocks approval; `warning` is shown. */
  level: z.enum(['error', 'warning']),
  file: z.string(),
  detail: z.string().optional(),
});
export type TaskValidation = z.infer<typeof validationSchema>;

export const taskRecordSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(TASK_ID_RE),
  /** The project's slug in the library. */
  project: z.string().regex(SLUG_RE),
  /** The project folder when the task started. */
  projectDir: z.string(),
  description: z.string(),
  profile: z.string(),
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS),
  state: z.enum(TASK_STATES),
  /** The branch checked out in the project folder when the task started (the default branch). */
  baseBranch: z.string(),
  /** Its last commit then: where the task's branch starts. */
  baseCommit: z.string(),
  branch: z.string(),
  /** Tracked settings files hidden in the worktree. */
  hidden: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  rounds: z.array(roundSchema),
  /** The project's own skills when the task started: the only ones a round is offered, whatever later rounds add. */
  skills: z.array(z.string()).optional(),
  /** The declared checks' results, absent until the user runs them from the proposal page (decisions.md, S8). */
  checks: z.array(checkResultSchema).optional(),
  validations: z.array(validationSchema).optional(),
  /** The branch's commit the validations read at the round's end: the one the page shows, the checks run on and approving applies. */
  reviewed: z.string().optional(),
  applied: z.object({ commit: z.string(), at: z.string() }).optional(),
  reverted: z.object({ commit: z.string(), at: z.string() }).optional(),
  /** Why the last action failed, redacted, without absolute paths. */
  error: z.string().optional(),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

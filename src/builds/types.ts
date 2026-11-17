import { z } from 'zod';
import { EFFORT_LEVELS } from '../models.js';
import { SLUG_RE } from '../spec/schema.js';
import { buildBranchOf, TASK_ID_RE } from '../tasks/types.js';

/**
 * A build (BRIEF-phase-9): a queue of tasks planned from a project's brief,
 * approved once and run one after another, unattended, on an integration
 * branch. One record per build in `<home>/builds/<id>/build.json`.
 */

/** Build ids have the same shape as task ids (a time and four hex digits). */
export const BUILD_ID_RE = TASK_ID_RE;

export const integrationBranchOf = buildBranchOf;

/** How many tasks a queue may hold. */
export const MAX_QUEUE = 20;
/** How many commands the approved list may hold. */
export const MAX_COMMANDS = 20;
export const MAX_COMMAND_LENGTH = 500;
/** How many declared checks a build may run (as a project's checks). */
export const MAX_BUILD_CHECKS = 10;
export const MAX_FIX_ROUNDS = 2;
export const DEFAULT_FIX_ROUNDS = 1;
/** The highest per-build cap on rounds. */
export const MAX_ROUNDS_CAP = 40;

/**
 * - `planning`: the planner session runs.
 * - `planned`: the queue waits on the start page.
 * - `planFailed`: the planner ended without a valid queue (`error`).
 * - `running`: a task runs, or the next one is about to start.
 * - `paused`: by the usage or the user; `pause` says why and until when.
 * - `interrupted`: the server stopped while it ran; only the user resumes it.
 * - `cancelled`: the user cancelled it; the integration branch stays.
 * - `finished`: the queue ended (some tasks may wait or be skipped).
 * - `applied`, `reverted`: the whole build on the default branch, and undone.
 * - `discarded`: the integration branch and the open worktrees are gone.
 */
export const BUILD_STATES = ['planning', 'planned', 'planFailed', 'running', 'paused', 'interrupted', 'cancelled', 'finished', 'applied', 'reverted', 'discarded'] as const;
export type BuildState = (typeof BUILD_STATES)[number];

/** States with no session, no checks and no loop at work: the build can be applied, discarded or resumed. */
export const SETTLED_BUILD_STATES: readonly BuildState[] = ['paused', 'interrupted', 'cancelled', 'finished'];
/** States in which the build holds its project (no ordinary task, no other build). */
export const OPEN_BUILD_STATES: readonly BuildState[] = ['planning', 'planned', 'running', 'paused', 'interrupted', 'cancelled', 'finished', 'planFailed'];

export const isOpenBuild = (state: BuildState): boolean => OPEN_BUILD_STATES.includes(state);

/** One item of a queue, as the planner proposes it and the user edits it. `dependsOn`: 1-based positions of earlier items. */
export const queueItemSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(4000),
  doneWhen: z.string().trim().min(1).max(1000),
  dependsOn: z.array(z.int().min(1).max(MAX_QUEUE)).max(MAX_QUEUE),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

/** What the planner returns (the session's structured output, validated again here). */
export const planOutputSchema = z.strictObject({
  tasks: z.array(queueItemSchema).min(1).max(MAX_QUEUE),
  /** Commands it proposes for the approved list (install, test, build, lint). Proposals only. */
  commands: z.array(z.string().max(MAX_COMMAND_LENGTH)).max(MAX_COMMANDS),
  /** Checks it proposes to run after each round. Proposals only. */
  checks: z.array(z.string().max(MAX_COMMAND_LENGTH)).max(MAX_BUILD_CHECKS),
});
export type PlanOutput = z.infer<typeof planOutputSchema>;

/**
 * - `queued`: not started yet.
 * - `running`: its task runs (a round or the checks).
 * - `applied`: one commit on the integration branch (`commit`).
 * - `waiting`: a rule failed (`reason`); the task waits for the user on its own page.
 * - `skipped`: it depends on a task that did not apply.
 * - `cancelled`: the build was cancelled while it ran.
 */
export const BUILD_TASK_STATES = ['queued', 'running', 'applied', 'waiting', 'skipped', 'cancelled'] as const;
export type BuildTaskState = (typeof BUILD_TASK_STATES)[number];

/** Why a task waits. */
export const WAIT_REASONS = ['checksFailed', 'denied', 'blocked', 'roundFailed', 'interrupted', 'notStarted', 'notApplied', 'roundsCap'] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

const buildTaskSchema = z.object({
  /** 1, 2, 3…: its place in the queue. */
  n: z.int().min(1),
  title: z.string(),
  instruction: z.string(),
  doneWhen: z.string(),
  dependsOn: z.array(z.int().min(1)),
  state: z.enum(BUILD_TASK_STATES),
  /** The phase 7 task that does it, once started. */
  taskId: z.string().regex(TASK_ID_RE).optional(),
  reason: z.enum(WAIT_REASONS).optional(),
  /** The task it was skipped for. */
  skippedFor: z.int().min(1).optional(),
  /** Short detail of the reason, redacted and without absolute paths. */
  detail: z.string().optional(),
  /** The commit on the integration branch. */
  commit: z.string().optional(),
  /** Commands and addresses denied in its rounds, as shown (redacted). */
  denied: z.array(z.object({ tool: z.string(), text: z.string() })).optional(),
  /** Rounds the build ran for it (the first and fix rounds). */
  rounds: z.int().min(0),
});
export type BuildTask = z.infer<typeof buildTaskSchema>;

export const buildSettingsSchema = z.object({
  /** How many tasks to run (default: all). */
  limit: z.int().min(1).max(MAX_QUEUE),
  /** The exact commands a round may run. */
  commands: z.array(z.string()),
  /** The checks that run after each round. */
  checks: z.array(z.string()),
  fixRounds: z.int().min(0).max(MAX_FIX_ROUNDS),
  /** The most rounds the whole build may run. */
  maxRounds: z.int().min(1).max(MAX_ROUNDS_CAP),
  /** Plan usage at or above these pauses the build (percent). */
  thresholds: z.object({ fiveHour: z.number().min(1).max(100), week: z.number().min(1).max(100) }),
});
export type BuildSettings = z.infer<typeof buildSettingsSchema>;

export const PAUSE_REASONS = ['usage', 'usageUnread', 'user'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const buildRecordSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(BUILD_ID_RE),
  project: z.string().regex(SLUG_RE),
  projectDir: z.string(),
  state: z.enum(BUILD_STATES),
  profile: z.string(),
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** `briefstack/build-<id>`: made at the start, never checked out in the user's folder. */
  branch: z.string(),
  /** The default branch and its head when the build started: where the integration branch starts. */
  baseBranch: z.string().optional(),
  baseCommit: z.string().optional(),
  /** The planner's queue and proposals, as it returned them. */
  plan: planOutputSchema.optional(),
  /** The queue the user approved, with each task's progress. Empty until the start. */
  tasks: z.array(buildTaskSchema),
  settings: buildSettingsSchema.optional(),
  /** Rounds run so far (against `settings.maxRounds`). */
  roundsRun: z.int().min(0),
  pause: z
    .object({
      reason: z.enum(PAUSE_REASONS),
      at: z.string(),
      /** When the build reads the usage again or resumes. */
      until: z.string().optional(),
      fiveHour: z.number().nullable().optional(),
      sevenDay: z.number().nullable().optional(),
    })
    .optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  applied: z.object({ commit: z.string(), at: z.string() }).optional(),
  reverted: z.object({ commit: z.string(), at: z.string() }).optional(),
  /** Why the last action or the planner failed, redacted, without absolute paths. */
  error: z.string().optional(),
})
  // A record never names another branch: an edited `build.json` cannot point the server's git at `main` (review of M1).
  .refine((record) => record.branch === buildBranchOf(record.id), { path: ['branch'], message: 'must be briefstack/build-<id>' });
export type BuildRecord = z.infer<typeof buildRecordSchema>;

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
/** How many denied commands a task of the build keeps in `build.json`; the rest are only counted (review of M3, minor; step 33). */
export const MAX_DENIED_KEPT = 50;

/** A task's denied list with `more` added, capped: the first ones kept, the others counted in `omitted`. */
export function capDenied(kept: readonly { tool: string; text: string }[], omitted: number, more: readonly { tool: string; text: string }[]): { denied: { tool: string; text: string }[]; deniedOmitted: number } {
  const all = [...kept, ...more];
  return { denied: all.slice(0, MAX_DENIED_KEPT), deniedOmitted: omitted + Math.max(0, all.length - MAX_DENIED_KEPT) };
}

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

/**
 * Whether the build's applied commit can be reverted: applied and not yet
 * reverted, also once discarded (discarding deletes only the integration
 * branch, which a revert does not need; review of step 33, part A, I-1).
 */
export const isRevertable = (record: { state: BuildState; applied?: unknown; reverted?: unknown }): boolean =>
  record.applied !== undefined && record.reverted === undefined && (record.state === 'applied' || record.state === 'discarded');

/** A card's expected size (BRIEF-phase-11 §2, 7). */
export const CARD_SIZES = ['S', 'M', 'L'] as const;
export type CardSize = (typeof CARD_SIZES)[number];
/** How many paths a card's area may name, and how long each may be. */
export const MAX_AREA_PATHS = 10;
export const MAX_AREA_PATH = 200;
/** How many cards a build may run at once (BRIEF-phase-11 §2, 5). */
export const MAX_SLOTS = 4;
/** What the start page offers; the API's default, without a value, is 1 (phase 9's behaviour). */
export const DEFAULT_PAGE_SLOTS = 2;

/** Control characters, and characters that print nothing or turn the text's direction. */
const hiddenCode = (code: number): boolean =>
  code < 0x20 || code === 0x7f || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;

/** Why a card's area cannot be taken: one of its paths (`empty` … `chars`), or how many there are (`count`). */
export const AREA_PROBLEMS = ['empty', 'long', 'absolute', 'parent', 'chars', 'count'] as const;
export type AreaProblem = (typeof AREA_PROBLEMS)[number];

/** Why a card's area cannot be taken, or `undefined`: no paths or too many, else the first path's problem. */
export function areaProblem(area: unknown): AreaProblem | undefined {
  if (!Array.isArray(area) || area.length === 0 || area.length > MAX_AREA_PATHS) return 'count';
  for (const item of area) {
    if (typeof item !== 'string') return 'chars';
    const problem = areaPathProblem(item);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Why a path cannot be in a card's area (a code the page translates), or `undefined`. */
export function areaPathProblem(raw: string): AreaProblem | undefined {
  // As the schema reads it: trimmed first (review of M1, minor 4).
  const value = raw.trim();
  if (value === '') return 'empty';
  if (value.length > MAX_AREA_PATH) return 'long';
  // Only relative paths with `/`: no backslash, wildcard, control or invisible character.
  if (/[\\*?[\]{}<>|"]/.test(value) || [...value].some((ch) => hiddenCode(ch.codePointAt(0) ?? 0))) return 'chars';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('~')) return 'absolute';
  if (value.split('/').some((part) => part === '..')) return 'parent';
  return undefined;
}

/** A path of a card's area: relative to the project, with `/`; `.` is the whole project. */
const areaPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AREA_PATH)
  .refine((value) => areaPathProblem(value) === undefined, { message: 'must be a relative path inside the project, with /' });

/**
 * A path's parts, without `.`, empty parts and case, in one Unicode form,
 * and without the trailing dots and spaces Windows drops from a name: what
 * the overlap compares (review of M1, minor 5). `[]` is the whole project.
 */
const areaParts = (value: string): string[] =>
  value
    .trim()
    .normalize('NFC')
    .toLowerCase()
    .split('/')
    .map((part) => part.replace(/[. ]+$/, ''))
    .filter((part) => part !== '');

/**
 * Whether two cards' areas may touch the same files (BRIEF-phase-11 §2, 4):
 * a path of one equal to, or a folder above or below, a path of the other,
 * without case (the conservative side on Windows and macOS). No area, an
 * empty one, or `.` is the whole project and overlaps everything.
 */
export function areasOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined || a.length === 0 || b.length === 0) return true;
  const within = (outer: string[], inner: string[]): boolean => outer.length <= inner.length && outer.every((part, i) => part === inner[i]);
  return a.map(areaParts).some((x) => b.map(areaParts).some((y) => within(x, y) || within(y, x)));
}

/**
 * One item of a queue, as the planner proposes it and the user edits it: a
 * card of the board (phase 11). `dependsOn`: 1-based positions of earlier
 * items. `area` and `size` are optional here, so builds planned before
 * phase 11 and phase 9's API read as they did; the planner is asked for
 * both (`plannerOutputSchema`).
 */
export const queueItemSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(4000),
  doneWhen: z.string().trim().min(1).max(1000),
  dependsOn: z.array(z.int().min(1).max(MAX_QUEUE)).max(MAX_QUEUE),
  /** Paths or folders the card is expected to touch: a scheduling hint, not a boundary (BRIEF-phase-11 §4). */
  area: z.array(areaPathSchema).min(1).max(MAX_AREA_PATHS).optional(),
  size: z.enum(CARD_SIZES).optional(),
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

/** What the planner session is asked for (its JSON schema): every card with its area and size (phase 11). */
export const plannerOutputSchema = planOutputSchema.extend({
  tasks: z.array(queueItemSchema.extend({ area: z.array(areaPathSchema).min(1).max(MAX_AREA_PATHS), size: z.enum(CARD_SIZES) })).min(1).max(MAX_QUEUE),
});

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
export const WAIT_REASONS = ['checksFailed', 'denied', 'blocked', 'roundFailed', 'interrupted', 'notStarted', 'notApplied', 'roundsCap', 'conflict', 'joinChecksFailed'] as const;

/** Why a card was redone, or waits after its redo (phase 11): a textual conflict, or checks failing on the joined commit. */
export const JOIN_FAILURES = ['conflict', 'checksFailed'] as const;
export type JoinFailure = (typeof JOIN_FAILURES)[number];
export type WaitReason = (typeof WAIT_REASONS)[number];

const buildTaskSchema = z.object({
  /** 1, 2, 3…: its place in the queue. */
  n: z.int().min(1),
  title: z.string(),
  instruction: z.string(),
  doneWhen: z.string(),
  dependsOn: z.array(z.int().min(1)),
  /** The card's area and size (phase 11); absent in builds started before, and then the whole project. */
  area: z.array(z.string()).optional(),
  size: z.enum(CARD_SIZES).optional(),
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
  /** Commands and addresses denied in its rounds, as shown (redacted); at most `MAX_DENIED_KEPT`. */
  denied: z.array(z.object({ tool: z.string(), text: z.string() })).optional(),
  /** How many denials were not kept past `MAX_DENIED_KEPT` (step 33). */
  deniedOmitted: z.int().min(0).optional(),
  /** Rounds the build ran for it (the first and fix rounds). */
  rounds: z.int().min(0),
  /** Its one redo (phase 11): why, and the task of the first attempt, discarded. */
  redo: z.object({ reason: z.enum(JOIN_FAILURES), previousTask: z.string().regex(TASK_ID_RE) }).optional(),
  /**
   * Its last join onto the integration branch (phase 11): applied onto the
   * head it started at, or `merged` onto one that moved (with the checks run
   * on the joined commit), or why it failed (the conflicted files).
   */
  join: z
    .object({
      outcome: z.enum(['applied', ...JOIN_FAILURES]),
      merged: z.boolean(),
      files: z.array(z.string()).optional(),
      checks: z.array(z.object({ command: z.string(), exitCode: z.int().nullable(), timedOut: z.boolean() })).optional(),
    })
    .optional(),
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
  /** How many cards run at once (phase 11); absent in builds started before, and then one. */
  slots: z.int().min(1).max(MAX_SLOTS).optional(),
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

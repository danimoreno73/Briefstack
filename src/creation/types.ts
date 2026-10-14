import type { FlowStep, StepPhase } from '../events/index.js';

/**
 * The contract between a creation session runner and the server.
 *
 * Two runners implement it: `SdkRunner` (H6) drives the real `/new-project`
 * skill through the Agent SDK, and `FakeRunner` replays a recorded creation
 * so tests spend no tokens. Both write the session's `events.jsonl` (the real
 * one through the skill's `briefstack event` calls and the hooks) and reach
 * the user only through `RunnerIO`, which the `CreationManager` implements.
 *
 * How the SDK maps onto it (PLAN-phase-2 §3, "Creation sessions"):
 * - `canUseTool` for `AskUserQuestion` → `io.askQuestions` (the answers go
 *   back in `updatedInput.answers`; a cancel becomes a deny that tells the
 *   skill to close the session as `cancelled`);
 * - `canUseTool` for anything else the guard hook sent to `ask` →
 *   `io.requestPermission`;
 * - MCP tool `approve_spec` → `io.approveSpec`;
 * - MCP tool `grant_directory` → `io.grantDirectory`;
 * - anything worth showing that hooks do not record → `io.emit`.
 */

/** What to do with a tool request nobody pre-approved (config `permissionPolicy`). */
export type PermissionPolicy = 'ask' | 'unattended';

/** One option of an `AskUserQuestion` question. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** One question, in `AskUserQuestion`'s input shape. */
export interface Question {
  question: string;
  /** Short chip label shown above the question. */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** A batch of 1–4 questions, as `AskUserQuestion` sends them. */
export interface QuestionRequest {
  questions: Question[];
}

/**
 * Answers keyed by question text: an option label, several labels joined by
 * ", " for `multiSelect`, or the user's own free text.
 */
export type QuestionAnswers = Record<string, string>;

export type QuestionResult = { decision: 'answer'; answers: QuestionAnswers } | { decision: 'cancel' };

/** A tool call nobody pre-approved. `summary` has already been through the secret redactor. */
export interface PermissionRequest {
  toolName: string;
  summary: string;
  /** Set when a subagent asked (the SDK's `agentID` resolved to its type). */
  agentType?: string;
}

export type PermissionDecision = 'allow' | 'deny';

/** The spec checkpoint: both files live in the session folder. */
export interface SpecApprovalRequest {
  specFile: string;
  summaryFile: string;
}

export type SpecDecision = { decision: 'approve' } | { decision: 'change'; text: string } | { decision: 'cancel' };

/** An output folder outside `projectsDir`, granted to this session only once confirmed. */
export interface GrantRequest {
  dir: string;
}

/** Progress a runner reports that `events.jsonl` does not carry (or not yet). */
export type RunnerEvent =
  | { kind: 'status'; status: 'starting' | 'running' | 'turnEnded' | 'stopping' | 'error'; message?: string }
  | { kind: 'agent'; phase: 'started' | 'stopped'; agentType: string; agentId?: string }
  | { kind: 'step'; step: FlowStep; phase: StepPhase }
  /** The runner refused a tool on its own, e.g. the guard hook after a cancel. */
  | { kind: 'denial'; toolName: string; summary: string; agentType?: string; reason: string };

/** How a runner reaches the user. Every promise is resolved by the browser (or by a cancel). */
export interface RunnerIO {
  askQuestions(request: QuestionRequest): Promise<QuestionResult>;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  approveSpec(request: SpecApprovalRequest): Promise<SpecDecision>;
  /** `true` once the user confirmed; the runner then allows writes there for this session only. */
  grantDirectory(request: GrantRequest): Promise<boolean>;
  emit(event: RunnerEvent): void;
}

/** The session model and effort of the active usage profile. */
export interface RunnerProfile {
  name: string;
  sessionModel?: string;
  effort?: string;
}

export interface RunnerStartOptions {
  /** The manager's id for this creation (not the Claude Code session id). */
  creationId: string;
  idea: string;
  profile: RunnerProfile;
  /** Where `<session id>/events.jsonl` is written. */
  sessionsDir: string;
  policy: PermissionPolicy;
  io: RunnerIO;
}

/**
 * How a runner ended. `ended`: it ran to its end by itself (the flow may or
 * may not have closed the session; `events.jsonl` says). `stopped`: after
 * `stop()`. `failed`: it could not run or crashed.
 */
export type RunnerOutcome = { kind: 'ended' } | { kind: 'stopped' } | { kind: 'failed'; error: string };

export interface RunnerHandle {
  /** The Claude Code session id, which names the session folder. */
  sessionId: Promise<string>;
  /**
   * Ask the flow to end as `cancelled` at its next step boundary, closing the
   * open step as `skipped`. Never kills anything mid-write.
   */
  requestCancel(): void;
  /** Ends the run now (server stop, or a cancel that timed out). Writes nothing to `events.jsonl`. */
  stop(): Promise<void>;
  done: Promise<RunnerOutcome>;
}

export interface CreationRunner {
  start(options: RunnerStartOptions): RunnerHandle;
}

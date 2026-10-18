/**
 * Improvement sessions (BRIEF-phase-5 §3.2): what a runner gets and gives
 * back. Two runners implement it, the real one over the Agent SDK and a fake
 * one for tests, like creations and the chat.
 */

/** One changed file as the session explains it. */
export interface SubmittedChange {
  /** Repo-relative, with `/`. */
  file: string;
  /** Why, citing the evidence. */
  rationale: string;
  /** Evidence files (relative to the evidence folder) the change rests on. */
  evidence: string[];
}

/** What the session hands in with `submit_proposal`. */
export interface Submission {
  /** One line: what the proposal changes. */
  title: string;
  /** What the user should expect to be different. */
  expectedEffect: string;
  changes: SubmittedChange[];
}

export type ImproveRunnerEvent =
  | { kind: 'status'; status: 'starting' | 'running' }
  /** The guard refused a tool call. `reason` is already redacted. */
  | { kind: 'denial'; tool: string; reason: string }
  /** The session's last text, redacted by the manager. */
  | { kind: 'text'; text: string };

export interface ImproveRunStart {
  proposalId: string;
  /** 1 for the first round, 2… after "ask for changes". */
  round: number;
  worktreeDir: string;
  evidenceDir: string;
  /** The command-hook guard's rules, outside the worktree and the evidence. */
  rulesFile: string;
  /** The user's request. */
  request: string;
  /** For a later round: the user's text from "ask for changes". */
  feedback?: string;
  /** For a later round: what the server did to the worktree before it (not the user's words). */
  notice?: string;
  model: string;
  effort?: string;
  emit(event: ImproveRunnerEvent): void;
}

export type ImproveRunOutcome =
  /** The session ended by itself; `submission` is absent when it never called `submit_proposal`. */
  | { kind: 'ended'; submission?: Submission }
  | { kind: 'failed'; error: string }
  | { kind: 'stopped' };

export interface ImproveRunHandle {
  done: Promise<ImproveRunOutcome>;
  stop(): Promise<void>;
}

export interface ImprovementRunner {
  start(options: ImproveRunStart): ImproveRunHandle;
}

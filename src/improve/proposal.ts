import type { DiffHunk } from '../chat/types.js';
import type { EvidenceItem } from './evidence.js';
import type { AssetKind } from './allowlist.js';

/**
 * A proposal: one improvement from the request to its end (BRIEF-phase-5
 * §3.3, §3.4). Stored as JSON under `<home>/improve/proposals/<id>.json`;
 * the page and the chat get `ProposalView`, which has no absolute path.
 */

export type ProposalStatus =
  /** The improvement session is running. */
  | 'preparing'
  /** The session ended; the server is validating and testing. */
  | 'verifying'
  /** Validators and tests passed: the user can approve. */
  | 'ready'
  /** A validator failed: it cannot be approved; the user can ask for changes or discard. */
  | 'rejected'
  /** The session, the tests or the git work failed. */
  | 'failed'
  /** Approved; waits until no creation is running. */
  | 'waiting'
  | 'applied'
  /** Revert asked; waits until no creation is running. */
  | 'revertWaiting'
  | 'reverted'
  | 'discarded';

export type ProblemKind =
  | 'forbiddenPath'
  | 'notModified'
  | 'mode'
  | 'notText'
  | 'frontmatter'
  | 'locked'
  | 'secret'
  | 'personalPath'
  | 'profileText'
  | 'noChanges'
  | 'unexplained';

export interface ValidationProblem {
  kind: ProblemKind;
  file?: string;
  line?: number;
  detail: string;
}

export interface CheckStep {
  name: 'build' | 'lint' | 'test';
  ok: boolean;
  ms: number;
  /** The last lines of its output, redacted, no absolute paths. */
  tail: string;
}

export interface CheckReport {
  ok: boolean;
  steps: CheckStep[];
  /** Why nothing could run, when that happened. */
  error?: string;
}

export interface ProposalFile {
  path: string;
  kind: AssetKind | 'other';
  status: 'added' | 'modified' | 'deleted' | 'other';
  /** The texts, when both are text and allowed; used to apply and to show the diff. */
  base?: string;
  proposed?: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  rationale?: string;
  evidence?: string[];
}

export interface Round {
  n: number;
  feedback?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: 'submitted' | 'noProposal' | 'failed' | 'stopped' | 'interrupted';
  /** The round's commit on the improvement branch. */
  commit?: string;
  denials: { tool: string; reason: string }[];
  /** The session's last text, redacted. */
  text?: string;
  error?: string;
}

export type RealCheckName = 'interviewer-target' | 'improvement-flow';

export interface RealCheck {
  name: RealCheckName;
  state: 'running' | 'passed' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** PASS/FAIL lines and the tail of the output, redacted. */
  output?: string;
}

export interface ProposalRecord {
  v: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
  /** The user's request, redacted. */
  request: string;
  suggestionId?: string;
  title?: string;
  expectedEffect?: string;
  evidence: EvidenceItem[];
  /** Branch `HEAD` was on when it was prepared: applying needs the repo there again. */
  baseBranch: string;
  baseCommit: string;
  branch: string;
  worktreeDir: string;
  rounds: Round[];
  files: ProposalFile[];
  validation?: { ok: boolean; problems: ValidationProblem[] };
  checks?: CheckReport;
  realCheck?: RealCheck;
  appliedCommit?: string;
  appliedAt?: string;
  revertCommit?: string;
  revertedAt?: string;
  /** Why the last action failed, redacted. */
  error?: string;
}

/** What the page and the chat see: no worktree path. */
export type ProposalView = Omit<ProposalRecord, 'worktreeDir' | 'v'> & {
  /** The real check this proposal offers, if any. */
  offeredCheck?: RealCheckName;
};

export interface ProposalSummary {
  id: string;
  status: ProposalStatus;
  title?: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  files: string[];
  appliedCommit?: string;
  revertCommit?: string;
}

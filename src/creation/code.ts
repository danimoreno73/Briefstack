import { z } from 'zod';
import { approvedListIssues, startIssueText, type StartIssue } from '../builds/commands.js';
import { MAX_BUILD_CHECKS, MAX_COMMANDS } from '../builds/types.js';

/**
 * The code choice of a creation (BRIEF-phase-10 §2, 5 and 8; PLAN-phase-10
 * §1, 1 and 2): at the spec checkpoint of the web app, for a `software`
 * project with the `claude-code` target, the user may ask for a first
 * version of the code. With it come the exact commands the implement step
 * may run, the declared checks, the fix passes and, when offered, Codex.
 * A pure module: the manager, the server and the tests share it.
 */

export const MAX_CODE_COMMANDS = MAX_COMMANDS;
export const MAX_CODE_CHECKS = MAX_BUILD_CHECKS;
export const MAX_FIX_PASSES = 2;
export const DEFAULT_FIX_PASSES = 1;

/** What the spec page sends with `approve` when the user chose code. */
export const codeChoiceSchema = z.strictObject({
  commands: z.array(z.string()).max(100),
  checks: z.array(z.string()).max(100),
  fixPasses: z.int().min(0).max(MAX_FIX_PASSES),
  codex: z.boolean(),
});
export type CodeChoice = z.infer<typeof codeChoiceSchema>;

/** Whether a spec may get code: a `software` project for Claude Code. */
export function specOffersCode(spec: { type?: unknown; target?: unknown } | null | undefined): boolean {
  return spec !== null && spec !== undefined && spec.type === 'software' && spec.target === 'claude-code';
}

/** Why the choice cannot be approved: the lists' problems as a build's start says them, and Codex asked when not offered. */
export interface CodeChoiceIssues {
  items: StartIssue[];
  codex: boolean;
}

/** The lists as builds' (`approvedListIssues`), Codex only when it is offered. */
export function codeChoiceIssues(choice: CodeChoice, options: { codexOffered: boolean }): CodeChoiceIssues {
  return {
    items: [...approvedListIssues(choice.commands, 'commands', MAX_CODE_COMMANDS), ...approvedListIssues(choice.checks, 'checks', MAX_CODE_CHECKS)],
    codex: choice.codex && !options.codexOffered,
  };
}

export const CODEX_REFUSED_TEXT = 'Codex is not available for creations now: turn it on and check it in Settings';
export const CODE_NOT_OFFERED_TEXT = 'code is offered only for a software project for Claude Code';

/** The same, in English (empty when the choice can be approved). */
export function codeChoiceProblems(choice: CodeChoice, options: { codexOffered: boolean }): string[] {
  const issues = codeChoiceIssues(choice, options);
  return [...issues.items.map(startIssueText), ...(issues.codex ? [CODEX_REFUSED_TEXT] : [])];
}

/** The code part of the spec page (`GET /api/creations/:id/spec`). */
export interface SpecCodeView {
  /** The spec may get code (type and target). */
  offered: boolean;
  /** The Codex checkbox is shown. */
  codex: boolean;
  maxCommands: number;
  maxChecks: number;
  maxFixPasses: number;
  defaultFixPasses: number;
}

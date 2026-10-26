import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { isFullyAbsolute, isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { redactSecretLines } from '../validate/secrets.js';
import { parseBriefstackCommand, type GuardDenial } from './guard.js';
import type { ClaimResult } from './types.js';

/**
 * Two creations never target the same project folder (BRIEF-phase-4 §3.2).
 *
 * The manager keeps one claim per active creation: the output folder its flow
 * chose. The flow names it in `paths check` (step 3 of the interview), then
 * in `grant_directory` when it is outside the projects folder, and the
 * generator in `scaffold`; each of those claims it. A folder that overlaps
 * another active creation's claim (the same, inside it, or around it) is
 * refused before anything is written there, and a write, `scaffold` or
 * `commit` into a folder another creation holds is denied.
 *
 * This is a `PreToolUse` hook of its own, next to the guard and not part of
 * it. Claude Code applies the strictest answer of all matching hooks
 * (`deny` > `ask` > `allow`, docs/decisions.md), so its deny wins over the
 * guard's allow.
 */

export type { ClaimResult };

interface Claim {
  dir: string;
  /** What the other creation is about, for the message: the start of its idea. */
  label: string;
}

const LABEL_LENGTH = 60;

export class FolderClaims {
  private readonly claims = new Map<string, Claim>();
  /**
   * Folders of creation sessions this server does not run (started from the
   * terminal, or by another server), read from their session folders
   * (`sessionFolder.ts`). Taken, never released here: each refresh replaces
   * the whole list.
   */
  private outside: Claim[] = [];

  constructor(private readonly pathEnv: PathEnv = systemPathEnv()) {}

  private overlaps(a: string, b: string): boolean {
    return isPathInside(a, b, this.pathEnv) || isPathInside(b, a, this.pathEnv);
  }

  /** Replaces the folders held outside this server. */
  setOutside(claims: readonly Claim[]): void {
    this.outside = claims.map((held) => ({ dir: this.pathEnv.pathApi.resolve(held.dir), label: redactSecretLines(held.label.trim()).slice(0, LABEL_LENGTH) }));
  }

  /** The creation `owner` takes `dir` (it replaces its earlier claim), unless another active creation holds an overlapping one. */
  claim(owner: string, dir: string, label: string): ClaimResult {
    const resolved = this.pathEnv.pathApi.resolve(dir);
    for (const [other, held] of this.claims) {
      if (other !== owner && this.overlaps(resolved, held.dir)) return { ok: false, holder: held.label };
    }
    for (const held of this.outside) {
      if (this.overlaps(resolved, held.dir)) return { ok: false, holder: held.label };
    }
    this.claims.set(owner, { dir: resolved, label: redactSecretLines(label.trim()).slice(0, LABEL_LENGTH) });
    return { ok: true };
  }

  /** The label of the other creation whose folder holds `target`, if any. */
  heldByOther(owner: string, target: string): string | undefined {
    const resolved = this.pathEnv.pathApi.resolve(target);
    for (const [other, held] of this.claims) {
      if (other !== owner && isPathInside(resolved, held.dir, this.pathEnv)) return held.label;
    }
    return this.outside.find((held) => isPathInside(resolved, held.dir, this.pathEnv))?.label;
  }

  release(owner: string): void {
    this.claims.delete(owner);
  }

  /** The folder `owner` holds now, if any. */
  of(owner: string): string | undefined {
    return this.claims.get(owner)?.dir;
  }
}

/**
 * How a refusal names the folder: relative to the projects folder when it is
 * inside it, else only as "that folder". Never an absolute path: the reason
 * is recorded in `events.jsonl` and shown in the panel.
 */
export function folderLabel(dir: string, projectsDir: string | undefined, pathEnv: PathEnv = systemPathEnv()): string {
  const { pathApi } = pathEnv;
  if (projectsDir !== undefined && isPathInside(pathApi.resolve(dir), projectsDir, pathEnv)) {
    const relative = pathApi.relative(projectsDir, pathApi.resolve(dir)).split(pathApi.sep).join('/');
    return relative === '' ? 'the projects folder itself' : `the folder "${relative}" in the projects folder`;
  }
  return 'that folder (outside the projects folder)';
}

/** The message the flow gets when a folder is taken: it tells the main session what to do next. */
export function claimRefusedMessage(dir: string, holder: string, projectsDir?: string, pathEnv?: PathEnv): string {
  return (
    `Another creation in progress ("${holder}") is using ${folderLabel(dir, projectsDir, pathEnv)} or one that overlaps it. ` +
    'Two creations cannot share a project folder. Ask the user for another folder.'
  );
}

export interface FolderClaimContext {
  isOwnSession(id: string): boolean;
  /** Reads the folders held outside this server again; the hook awaits it before deciding. */
  refresh?(): Promise<void>;
  claim(dir: string): ClaimResult;
  heldByOther(target: string): string | undefined;
  /** The projects folder, which the refusal names the folder against. */
  projectsDir?: string;
  pathEnv?: PathEnv;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Options of the claiming commands that take a value. */
const VALUE_OPTIONS = new Set(['--session']);

export type ClaimVerdict = { verdict: 'pass' } | { verdict: 'deny'; reason: string; summary: string };

/** Decides one tool call: claims a folder the flow names, refuses one another creation holds. */
export function evaluateFolderClaim(
  ctx: FolderClaimContext,
  input: { session_id: string; tool_name: string; tool_input: unknown },
): ClaimVerdict {
  if (!ctx.isOwnSession(input.session_id)) return { verdict: 'pass' };
  const pathEnv = ctx.pathEnv ?? systemPathEnv();
  const fields = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;
  const absolute = (value: string | undefined): value is string => value !== undefined && isFullyAbsolute(value, pathEnv.pathApi);
  const refuse = (dir: string, holder: string, summary: string): ClaimVerdict => ({
    verdict: 'deny',
    reason: claimRefusedMessage(dir, holder, ctx.projectsDir, pathEnv),
    summary: redactSecretLines(summary).slice(0, 500),
  });

  if (SHELL_TOOLS.has(input.tool_name)) {
    const command = typeof fields.command === 'string' ? fields.command : '';
    const parsed = parseBriefstackCommand(command);
    // Anything the guard would refuse is left to it.
    if (!parsed.ok) return { verdict: 'pass' };
    const [sub, second] = parsed.argv;
    // The words that are not options, nor the value of one (`--session SESSION` of `paths check`).
    const positionals = (from: number) =>
      parsed.argv.slice(from).filter((word, index, words) => !word.startsWith('-') && !VALUE_OPTIONS.has(words[index - 1] ?? ''));
    if (sub === 'paths' && second === 'check') {
      const dir = positionals(2)[0];
      if (!absolute(dir)) return { verdict: 'pass' };
      const result = ctx.claim(dir);
      return result.ok ? { verdict: 'pass' } : refuse(dir, result.holder, command);
    }
    if (sub === 'scaffold') {
      const dir = positionals(1)[1];
      if (!absolute(dir)) return { verdict: 'pass' };
      const result = ctx.claim(dir);
      return result.ok ? { verdict: 'pass' } : refuse(dir, result.holder, command);
    }
    if (sub === 'commit') {
      const dir = positionals(1)[0];
      if (!absolute(dir)) return { verdict: 'pass' };
      const holder = ctx.heldByOther(dir);
      return holder === undefined ? { verdict: 'pass' } : refuse(dir, holder, command);
    }
    return { verdict: 'pass' };
  }

  if (WRITE_TOOLS.has(input.tool_name)) {
    const raw = input.tool_name === 'NotebookEdit' ? fields.notebook_path : fields.file_path;
    const target = typeof raw === 'string' ? raw : undefined;
    if (!absolute(target)) return { verdict: 'pass' };
    const holder = ctx.heldByOther(target);
    return holder === undefined ? { verdict: 'pass' } : refuse(pathEnv.pathApi.dirname(target), holder, target);
  }
  return { verdict: 'pass' };
}

/** The `PreToolUse` callback; `onDeny` reports a refusal like a guard denial. */
export function folderClaimHook(ctx: FolderClaimContext, onDeny: (denial: GuardDenial) => void = () => undefined): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    // Only the calls that can claim or write read the disk; a failed read keeps the last list.
    if ((SHELL_TOOLS.has(input.tool_name) || WRITE_TOOLS.has(input.tool_name)) && ctx.isOwnSession(input.session_id)) await ctx.refresh?.().catch(() => undefined);
    const verdict = evaluateFolderClaim(ctx, input);
    if (verdict.verdict === 'pass') return {};
    const denial: GuardDenial = { toolName: input.tool_name, summary: verdict.summary, reason: verdict.reason };
    if (input.agent_type !== undefined && input.agent_type !== '') denial.agentType = input.agent_type;
    if (input.agent_id !== undefined && input.agent_id !== '') denial.agentId = input.agent_id;
    if (input.tool_use_id !== '') denial.toolUseId = input.tool_use_id;
    onDeny(denial);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
  };
}

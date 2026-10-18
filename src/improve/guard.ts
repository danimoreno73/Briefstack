import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { stat } from 'node:fs/promises';
import { isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { classifyPath, hasGitSegment, insideAny } from '../creation/guard.js';
import { realpathNearest } from '../scaffold/outputDir.js';
import { redactSecretLines } from '../validate/secrets.js';
import { classifyAsset } from './allowlist.js';

/**
 * The guard of an improvement session (BRIEF-phase-5 §3.2, §4). Separate from
 * the creation guard, and stricter:
 *
 * - reads (`Read`, `Glob`, `Grep`) only inside the worktree and the evidence
 *   folders, never in a `.git` folder or `node_modules`; a `Glob` pattern
 *   must be relative and without `..`;
 * - writes (`Write`, `Edit`) only to allowlisted files that already exist in
 *   the worktree (`allowlist.ts`), never in a `.git` folder;
 * - the session's own `submit_proposal` tool;
 * - every other tool is denied.
 *
 * Three places apply it: a `PreToolUse` callback (`improveGuardHook`), a
 * command hook Claude Code runs itself (`guardCommand.ts`, which holds when
 * the server is gone), and `canUseTool`, because Claude Code asks again for a
 * write in `.claude/` even after a hook allowed it (docs/decisions.md,
 * phase 5 H0 #1).
 */

export interface ImproveGuardRules {
  /** The worktree the session works in. */
  worktree: string;
  /** Folders the session may read: its evidence. */
  evidence: readonly string[];
  /** The full name of the session's `submit_proposal` tool. */
  submitTool: string;
}

export type ImproveVerdict = { verdict: 'allow'; reason: string } | { verdict: 'deny'; reason: string };

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);

/** The tools an improvement session is offered (`--tools`). No shell, no web, no agents. */
export const IMPROVE_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'] as const;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function relativeTo(root: string, target: string, pathEnv: PathEnv): string {
  return pathEnv.pathApi.relative(root, target).split(pathEnv.pathApi.sep).join('/');
}

const deny = (reason: string): ImproveVerdict => ({ verdict: 'deny', reason });

/** Whether a glob pattern starts at a root of its own: absolute on any platform, a drive, a share, or `~`. */
function isRootedPattern(pattern: string, pathEnv: PathEnv): boolean {
  return pathEnv.pathApi.isAbsolute(pattern) || /^[\\/]/.test(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.startsWith('~');
}

/** Decides one tool call. Pure apart from reading the disk (symlinks, existence). */
export async function evaluateImproveToolUse(
  rules: ImproveGuardRules,
  input: { tool_name: string; tool_input: unknown },
  pathEnv: PathEnv = systemPathEnv(),
): Promise<ImproveVerdict> {
  const tool = input.tool_name;
  const fields = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;
  const { pathApi } = pathEnv;

  if (tool === rules.submitTool) return { verdict: 'allow', reason: 'the session hands in its proposal' };

  if (READ_TOOLS.has(tool)) {
    // A Glob pattern can name its own root: only patterns relative to the checked path, never climbing out of it.
    if (tool === 'Glob') {
      const pattern = typeof fields.pattern === 'string' ? fields.pattern : '';
      if (isRootedPattern(pattern, pathEnv) || pattern.includes('..')) return deny('Glob patterns must be relative to the worktree or the evidence folder, without "..".');
    }
    const given = text(fields.file_path) ?? text(fields.path);
    // No path: Glob and Grep search the working folder, which is the worktree.
    const target = given === undefined ? rules.worktree : pathApi.resolve(rules.worktree, given);
    if (hasGitSegment(target) || /(^|[\\/])node_modules([\\/]|$)/i.test(target)) return deny('Reading .git or node_modules is not allowed here.');
    if (!(await insideAny(target, [rules.worktree, ...rules.evidence], pathEnv))) {
      return deny('Reads are only allowed inside the worktree and the evidence folder.');
    }
    return { verdict: 'allow', reason: 'a read inside the worktree or the evidence' };
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = text(fields.file_path);
    if (target === undefined) return deny('The write has no file path.');
    if (classifyPath(target, pathEnv) !== 'ok') return deny('Use the absolute path of the file inside the worktree.');
    if (hasGitSegment(target)) return deny('Writing inside a .git folder is not allowed.');
    let real: string;
    let root: string;
    try {
      real = await realpathNearest(pathApi.resolve(target));
      root = await realpathNearest(rules.worktree);
    } catch {
      return deny('The path cannot be resolved.');
    }
    if (!isPathInside(real, root, pathEnv) || real === root) return deny('Writes are only allowed inside the worktree.');
    const relative = relativeTo(root, real, pathEnv);
    if (classifyAsset(relative) === undefined) {
      return deny(`${relative} is not a file an improvement may change. Only agent and skill bodies and the base library's templates and rules.`);
    }
    try {
      if (!(await stat(real)).isFile()) return deny(`${relative} is not a file.`);
    } catch {
      return deny(`${relative} does not exist. An improvement only edits existing files: no new files.`);
    }
    return { verdict: 'allow', reason: 'an allowlisted file in the worktree' };
  }

  return deny(`The tool ${tool} is not available in an improvement session.`);
}

const short = (value: string): string => redactSecretLines(value).slice(0, 500);

/** The `PreToolUse` callback. `onDeny` reports each denial to the server. */
export function improveGuardHook(rules: ImproveGuardRules, onDeny: (tool: string, reason: string) => void = () => undefined, pathEnv?: PathEnv): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const verdict = await evaluateImproveToolUse(rules, { tool_name: input.tool_name, tool_input: input.tool_input }, pathEnv);
    if (verdict.verdict === 'deny') onDeny(input.tool_name, short(verdict.reason));
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.verdict,
        permissionDecisionReason: verdict.reason,
      },
    };
  };
}

/** `canUseTool`: the guard's answer again; nothing else is ever allowed. */
export function improveCanUseTool(rules: ImproveGuardRules, pathEnv?: PathEnv): CanUseTool {
  return async (toolName, input) => {
    const verdict = await evaluateImproveToolUse(rules, { tool_name: toolName, tool_input: input }, pathEnv);
    return verdict.verdict === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.reason };
  };
}

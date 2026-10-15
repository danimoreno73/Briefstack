import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { isFullyAbsolute, isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { realpathNearest } from '../scaffold/outputDir.js';
import { redactSecretLines } from '../validate/secrets.js';

/**
 * The guard of a creation session (PLAN-phase-2 §3 "SdkRunner", H6).
 *
 * It is a `PreToolUse` callback that only `SdkRunner` registers, through the
 * `hooks` option of its own `query()`. No settings file mentions it, so
 * ordinary Claude Code sessions in this repo never run it, and it ignores
 * any hook input whose `session_id` is not the creation's own. Hooks run
 * before the permission mode, so the auto classifier never decides what the
 * guard allows or denies.
 *
 * What it decides:
 * - file writes only inside `projectsDir`, the session folder and the
 *   folders the user granted to this session; anything else is denied;
 * - shell commands only as `npm run --silent briefstack -- <sub> ...` with
 *   no shell operators, and only the subcommands each caller needs;
 * - after a cancel, nothing except the `briefstack event` calls that close
 *   the session;
 * - web access for the researcher is allowed.
 * Everything else is left to the permission mode and `canUseTool`.
 */

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

export type Caller = 'main' | 'generator' | 'reviewer' | 'other';

/** The subcommands of `briefstack` each caller may run (the table in PLAN-phase-2 "Pending for H6"). */
export const ALLOWED_SUBCOMMANDS: Readonly<Record<Exclude<Caller, 'other'>, readonly (readonly string[])[]>> = {
  main: [['event'], ['paths'], ['usage', 'show'], ['library', 'context'], ['library', 'add'], ['spec', 'check'], ['validate'], ['commit']],
  generator: [['scaffold'], ['validate']],
  reviewer: [['validate']],
};

/** Who is calling: the main session has no `agent_id`; a subagent is told apart by its type. */
export function callerOf(input: { agent_id?: string | undefined; agent_type?: string | undefined }): Caller {
  if (input.agent_id === undefined || input.agent_id === '') return 'main';
  if (input.agent_type === 'generator') return 'generator';
  if (input.agent_type === 'reviewer') return 'reviewer';
  return 'other';
}

const PREFIX = ['npm', 'run', '--silent', 'briefstack', '--'] as const;

/** Characters allowed outside double quotes. No operator, glob, expansion or escape character is among them. */
const PLAIN_CHARS = /^[A-Za-z0-9_.\-/:=,]$/;
/** Inside double quotes these still run code or escape in bash or PowerShell, or end the quote. */
const QUOTED_FORBIDDEN = /[$`\\"\r\n\0]/;

export type ParsedCommand = { ok: true; argv: string[] } | { ok: false; reason: string };

/**
 * Reads a shell command as `npm run --silent briefstack -- <args>` and returns
 * the arguments. Anything it does not understand token for token is refused:
 * no `;`, `&`, `|`, redirects, subshells, backticks, `$`, globs, single
 * quotes, backslashes or newlines, and no text after a closing quote that
 * could start something else.
 */
export function parseBriefstackCommand(command: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) return { ok: false, reason: 'unterminated quote' };
      const body = command.slice(i + 1, end);
      if (QUOTED_FORBIDDEN.test(body)) return { ok: false, reason: 'a quoted argument has $, a backtick, a backslash or a line break' };
      current += body;
      inToken = true;
      i = end + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      i += 1;
      continue;
    }
    if (!PLAIN_CHARS.test(ch)) return { ok: false, reason: `the character ${JSON.stringify(ch)} is not allowed outside quotes` };
    current += ch;
    inToken = true;
    i += 1;
  }
  if (inToken) tokens.push(current);

  for (const [index, expected] of PREFIX.entries()) {
    if (tokens[index] !== expected) return { ok: false, reason: 'not a briefstack CLI command' };
  }
  return { ok: true, argv: tokens.slice(PREFIX.length) };
}

/** The subcommand that matches `argv` for `caller`, e.g. `['usage', 'show']`, or `undefined`. */
export function matchSubcommand(caller: Caller, argv: readonly string[]): readonly string[] | undefined {
  if (caller === 'other') return undefined;
  return ALLOWED_SUBCOMMANDS[caller].find((sub) => sub.every((word, index) => argv[index] === word));
}

export type PathClass = 'ok' | 'relative' | 'not-fully-absolute';

/**
 * Lexical look at a path before the disk is consulted: a relative path, or a
 * rooted one without a drive on Windows (a Git Bash `/c/Users/...`), is never
 * accepted as it stands.
 */
export function classifyPath(value: string, pathEnv: Pick<PathEnv, 'pathApi'>): PathClass {
  const { pathApi } = pathEnv;
  if (!pathApi.isAbsolute(value)) return 'relative';
  return isFullyAbsolute(value, pathApi) ? 'ok' : 'not-fully-absolute';
}

export interface GuardContext {
  /**
   * Whether a hook input belongs to this creation. The runner claims the
   * session id the first time it sees one, so a hook that fires before the
   * init message is read is still ours.
   */
  isOwnSession(sessionId: string): boolean;
  /** The folder of this creation's files, `<sessionsDir>/<session id>`. */
  sessionDir(sessionId: string): string;
  projectsDir: string;
  /** Folders the user confirmed for this session only. Read on every call. */
  grantedDirs(): readonly string[];
  /** Whether the user cancelled. Read on every call. */
  cancelled(): boolean;
  pathEnv?: PathEnv;
}

export interface GuardInput {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  agent_id?: string | undefined;
  agent_type?: string | undefined;
}

export type GuardVerdict =
  /** The guard pre-approves it. */
  | { verdict: 'allow'; reason: string }
  | { verdict: 'deny'; reason: string; summary: string }
  /** Not the guard's business: the permission mode decides. */
  | { verdict: 'pass' };

const CANCEL_MESSAGE =
  'The user cancelled this creation. Do nothing else: close the open step as skipped and then close the session with ' +
  '`event session finished --outcome cancelled`, as the skill says for a cancel, and stop.';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** `file_path`, or `notebook_path`, of a write tool. */
function targetOf(toolName: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  return text(toolName === 'NotebookEdit' ? fields.notebook_path : fields.file_path);
}

/** Whether `target` is inside one of `roots`, after symlinks are resolved on both sides. */
export async function insideAny(target: string, roots: readonly string[], pathEnv: PathEnv): Promise<boolean> {
  let real: string;
  try {
    real = await realpathNearest(pathEnv.pathApi.resolve(target));
  } catch {
    return false;
  }
  for (const root of roots) {
    try {
      if (isPathInside(real, await realpathNearest(root), pathEnv)) return true;
    } catch {
      // A root that cannot be resolved allows nothing.
    }
  }
  return false;
}

const redact = (value: string): string => redactSecretLines(value).slice(0, 500);

/** Decides one tool call. Pure apart from reading symlinks on the disk. */
export async function evaluateToolUse(ctx: GuardContext, input: GuardInput): Promise<GuardVerdict> {
  if (!ctx.isOwnSession(input.session_id)) return { verdict: 'pass' };
  const pathEnv = ctx.pathEnv ?? systemPathEnv();
  const caller = callerOf(input);
  const tool = input.tool_name;
  const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;

  const deny = (reason: string, summary: string): GuardVerdict => ({ verdict: 'deny', reason, summary: redact(summary) });
  const roots = (): string[] => [ctx.projectsDir, ctx.sessionDir(input.session_id), ...ctx.grantedDirs()];

  if (SHELL_TOOLS.has(tool)) {
    const command = text(toolInput.command) ?? '';
    const summary = command;
    const parsed = parseBriefstackCommand(command);
    if (ctx.cancelled()) {
      // Only the calls that close the session still go through.
      if (parsed.ok && caller === 'main' && parsed.argv[0] === 'event') return { verdict: 'allow', reason: 'closing a cancelled session' };
      return deny(CANCEL_MESSAGE, summary);
    }
    if (!parsed.ok) {
      return deny(
        `This command is not allowed (${parsed.reason}). The only shell commands are ` +
          '`npm run --silent briefstack -- <command> ...`, one per call, with no `;`, `&&`, `|`, redirects or `$(...)`, ' +
          'and with absolute paths in double quotes using forward slashes.',
        summary,
      );
    }
    const sub = matchSubcommand(caller, parsed.argv);
    if (sub === undefined) {
      return deny(
        caller === 'other'
          ? 'This agent has no shell access.'
          : `The briefstack command \`${parsed.argv.slice(0, 2).join(' ')}\` is not allowed for ${caller === 'main' ? 'the main session' : `the ${caller} agent`}.`,
        summary,
      );
    }
    // Commands that write on their own must point inside the folders a creation may write to.
    if (sub[0] === 'scaffold' || sub[0] === 'commit') {
      const positionals = parsed.argv.slice(sub.length).filter((word) => !word.startsWith('-'));
      const target = sub[0] === 'scaffold' ? positionals[1] : positionals[0];
      if (target !== undefined) {
        const kind = classifyPath(target, pathEnv);
        if (kind !== 'ok') {
          return deny('Use a full path with a drive letter or a leading slash, in double quotes with forward slashes.', summary);
        }
        if (!(await insideAny(target, roots(), pathEnv))) {
          return deny('That folder is outside the projects folder and the folders the user granted for this creation.', summary);
        }
      }
    }
    return { verdict: 'allow', reason: 'a briefstack CLI command this caller needs' };
  }

  if (ctx.cancelled()) return deny(CANCEL_MESSAGE, `${tool}`);

  if (WRITE_TOOLS.has(tool)) {
    const target = targetOf(tool, toolInput);
    if (target === undefined) return deny('The write has no file path.', tool);
    const kind = classifyPath(target, pathEnv);
    if (kind === 'relative') return deny('Use an absolute path.', target);
    if (kind === 'not-fully-absolute') return deny('Use a full path with a drive letter, not a /c/... form.', target);
    if (await insideAny(target, roots(), pathEnv)) return { verdict: 'allow', reason: 'inside an allowed folder' };
    return deny(
      'Writes are only allowed inside the projects folder, this creation\'s session folder and folders the user granted for it.',
      target,
    );
  }

  if (WEB_TOOLS.has(tool) && input.agent_type === 'researcher') {
    return { verdict: 'allow', reason: 'read-only web access for the researcher' };
  }
  return { verdict: 'pass' };
}

export interface GuardDenial {
  toolName: string;
  summary: string;
  agentType?: string;
  reason: string;
}

/**
 * The `PreToolUse` callback for `query({ options: { hooks } })`. `onDeny`
 * reports each denial so it is listed with the creation's other denials.
 */
export function guardHook(ctx: GuardContext, onDeny: (denial: GuardDenial) => void = () => undefined): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const verdict = await evaluateToolUse(ctx, {
      session_id: input.session_id,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      agent_id: input.agent_id,
      agent_type: input.agent_type,
    });
    if (verdict.verdict === 'pass') return {};
    if (verdict.verdict === 'allow') {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: verdict.reason },
      };
    }
    const denial: GuardDenial = { toolName: input.tool_name, summary: verdict.summary, reason: verdict.reason };
    if (input.agent_type !== undefined && input.agent_type !== '') denial.agentType = input.agent_type;
    onDeny(denial);
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason },
    };
  };
}

/** The session folder of a creation. */
export function sessionDirOf(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId);
}

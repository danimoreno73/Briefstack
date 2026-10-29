import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecretLines } from '../validate/secrets.js';

/**
 * Shell commands and web requests in a task (BRIEF-phase-7 §3.2; PLAN §1,
 * 3; decisions.md, "Phase 7: H0", 5). Each one the user has not allowed for
 * this task opens a dialog with three answers: once, this exact one for the
 * rest of the task, or deny. "This exact one" is the tool name and the whole
 * command string (or address, or query), byte for byte: never split, never a
 * prefix, never normalised. It is kept in memory and forgotten when the task
 * ends.
 *
 * Every decision is also written to the task's approvals folder, keyed by
 * the tool call's id, so the command-hook guard (which Claude Code runs on
 * its own, in parallel with the server's callback) lets the call through
 * only when the server recorded the user's yes for that call and that exact
 * command (`guardCommand.ts`).
 */

/** A dialog not answered for this long is a deny: a minute under the hook's own hour, as the chat's cards. */
export const TASK_DIALOG_TIMEOUT_MS = 59 * 60_000;
/** The SDK callback hook's timeout for these calls, in seconds. */
export const TASK_HOOK_TIMEOUT_S = 60 * 60;

export type ShellAnswer = 'once' | 'task' | 'deny';

export type CommandFeature = 'and' | 'or' | 'sequence' | 'pipe' | 'background' | 'newline' | 'substitution' | 'backtick' | 'processSubstitution' | 'redirect';

/** What the dialog shows of a command. The parsing is for display only: the approval is for the whole string. */
export interface CommandDisplay {
  /** The whole command, with lines that look like secrets hidden. */
  text: string;
  /** Whether part of it is hidden. */
  redacted: boolean;
  /** Separators, substitutions and redirects found outside quotes. */
  features: CommandFeature[];
  /** More than one command in the string. */
  compound: boolean;
  /** It runs git, which runs the project's own git hooks. */
  runsGit: boolean;
}

/** Scans a command outside single and double quotes for what makes it more than one plain command. */
export function describeCommand(command: string): CommandDisplay {
  const features = new Set<CommandFeature>();
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === '\\' && quote === undefined) {
      i += 1;
      continue;
    }
    // Substitutions run inside double quotes too.
    if (ch === '$' && next === '(') features.add('substitution');
    if (ch === '`') features.add('backtick');
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === '<' || ch === '>') && next === '(') features.add('processSubstitution');
    else if (ch === '>' || ch === '<') features.add('redirect');
    if (ch === '&' && next === '&') {
      features.add('and');
      i += 1;
    } else if (ch === '|' && next === '|') {
      features.add('or');
      i += 1;
    } else if (ch === '|') features.add('pipe');
    else if (ch === '&' && command.charAt(i - 1) !== '>' && next !== '>') features.add('background');
    else if (ch === ';') features.add('sequence');
    else if (ch === '\n' || ch === '\r') {
      if (command.slice(i + 1).trim() !== '') features.add('newline');
    }
  }
  const shown = redactSecretLines(command);
  const list = [...features];
  const compound = list.some((feature) => feature !== 'redirect');
  const runsGit = /(^|[\s;&|(`]|\$\()git(\.exe)?(\s|$)/i.test(command);
  return { text: shown, redacted: shown !== command, features: list, compound, runsGit };
}

/** What the dialog asks about. */
export interface ApprovalRequest {
  kind: 'shell' | 'web';
  tool: string;
  /** The command, address or query, as it will run. Never shown as it is: `display.text` is. */
  key: string;
  display: CommandDisplay;
  /** Set when a subagent made the call. */
  agentType?: string;
}

const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The hash the approval records hold: the tool and the whole key. */
export const approvalHash = (tool: string, key: string): string => createHash('sha256').update(`${tool}\u0000${key}`, 'utf8').digest('hex');

export interface ApprovalRecord {
  v: 1;
  decision: 'allow' | 'deny';
  hash: string;
}

/** The record file of one tool call in the approvals folder, or `undefined` for an id that is not one. */
export function approvalFile(dir: string, toolUseId: string): string | undefined {
  return TOOL_USE_ID_RE.test(toolUseId) ? path.join(dir, `${toolUseId}.json`) : undefined;
}

/**
 * The approvals of one task: the exact commands the user allowed for the
 * rest of it, and the per-call records for the command-hook guard.
 */
export class TaskApprovals {
  private readonly exact = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly ask: (request: ApprovalRequest) => Promise<ShellAnswer>,
  ) {}

  /** Whether `key` is allowed for the rest of the task with this tool. */
  allowedForTask(tool: string, key: string): boolean {
    return this.exact.has(approvalHash(tool, key));
  }

  /** The exact commands, addresses and queries allowed for the task, by hash (for tests and the page's count). */
  get size(): number {
    return this.exact.size;
  }

  /** Decides one call: asks unless it is allowed for the task, and records the decision for the command hook. */
  async decide(toolUseId: string | undefined, request: Omit<ApprovalRequest, 'display'> & { display?: CommandDisplay }): Promise<'allow' | 'deny'> {
    const hash = approvalHash(request.tool, request.key);
    const file = toolUseId === undefined ? undefined : approvalFile(this.dir, toolUseId);
    if (file === undefined) return 'deny';
    let decision: 'allow' | 'deny' = 'allow';
    if (!this.exact.has(hash)) {
      const display = request.display ?? describeCommand(request.key);
      const answer = await this.ask({ ...request, display });
      if (answer === 'deny') decision = 'deny';
      else if (answer === 'task') this.exact.add(hash);
    }
    await this.write(file, { v: 1, decision, hash });
    return decision;
  }

  /** The call ran (or failed): its record is no longer needed. */
  async forget(toolUseId: string | undefined): Promise<void> {
    const file = toolUseId === undefined ? undefined : approvalFile(this.dir, toolUseId);
    if (file !== undefined) await rm(file, { force: true });
  }

  /** The task ended: nothing is remembered. */
  async clear(): Promise<void> {
    this.exact.clear();
    await this.clearRecords();
  }

  /** A round ended: the per-call records go; what the user allowed for the task stays. */
  async clearRecords(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) await rm(path.join(this.dir, name), { force: true });
  }

  private async write(file: string, record: ApprovalRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(record)}\n`, 'utf8');
    await rename(temp, file);
  }
}

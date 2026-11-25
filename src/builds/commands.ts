import { describeCommand } from '../tasks/shell.js';
import { redactSecretLines } from '../validate/secrets.js';
import { MAX_COMMAND_LENGTH, MAX_COMMANDS } from './types.js';

/**
 * The exact commands approved at a build's start (BRIEF-phase-9 §2, 6 and
 * §4). A round may run a command only when it is, byte for byte, an item
 * of the list, or a chain of `&&`, `||` or `;` whose every part, trimmed,
 * is an item. Nothing else matches: no wildcard, no prefix, no pipe,
 * redirect, substitution, background job or second line outside an item
 * written exactly so. Anything that does not match is denied without a
 * dialog and recorded.
 */

/** Why a command cannot be on the approved list: a code the page translates (step 33). */
export const COMMAND_PROBLEMS = ['empty', 'spaces', 'lines', 'long', 'secret', 'invisible', 'compound', 'wildcard', 'chars', 'quote'] as const;
export type CommandProblem = (typeof COMMAND_PROBLEMS)[number];

/** Each problem in English, as the server's error text says it. */
export const COMMAND_PROBLEM_TEXT: Readonly<Record<CommandProblem, string>> = {
  empty: 'empty',
  spaces: 'spaces at the start or end',
  lines: 'more than one line',
  long: `longer than ${MAX_COMMAND_LENGTH} characters`,
  secret: 'a part that looks like a secret',
  invisible: 'an invisible character',
  compound: 'more than one command (list each part on its own)',
  wildcard: 'a wildcard',
  chars: 'a character other than letters, digits, spaces, quotes and - _ . / : = @ + ,',
  quote: 'a quote that is not closed',
};

/** Why a command cannot be on the approved list (its code), or `undefined`. */
export function approvedCommandProblemCode(command: string): CommandProblem | undefined {
  if (command.trim() === '') return 'empty';
  if (command !== command.trim()) return 'spaces';
  if (/[\r\n\0]/.test(command)) return 'lines';
  if (command.length > MAX_COMMAND_LENGTH) return 'long';
  // The same reading the task's dialog uses: a part that looks like a secret, or a character that hides text.
  if (redactSecretLines(command) !== command) return 'secret';
  const display = describeCommand(command);
  if (display.features.includes('invisible')) return 'invisible';
  if (display.compound) return 'compound';
  if (/[*?[\]{}]/.test(command)) return 'wildcard';
  // Only characters that no shell (sh, bash, cmd, PowerShell) reads as anything but text: a backslash, a bracket, `$`,
  // `%`, `^`, `!`, `~` or `#` could make one item several commands in one of them (review of M2, I1).
  if (!SAFE_ITEM_RE.test(command)) return 'chars';
  if ((command.match(/"/g)?.length ?? 0) % 2 !== 0 || (command.match(/'/g)?.length ?? 0) % 2 !== 0) return 'quote';
  return undefined;
}

/** Why a command cannot be on the approved list, in English, or `undefined`. */
export function approvedCommandProblem(command: string): string | undefined {
  const code = approvedCommandProblemCode(command);
  return code === undefined ? undefined : COMMAND_PROBLEM_TEXT[code];
}

/** What an approved item may hold. */
const SAFE_ITEM_RE = /^[A-Za-z0-9 _\-./:=@+,"']+$/;

/** Spaces and tabs only: not every character `String.trim` removes. */
const trimBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, '');

/** The problems of a whole list (none when it can be approved), each line's with its 1-based line. */
export function approvedListIssues(commands: readonly string[], what: 'commands' | 'checks', max = MAX_COMMANDS): StartIssue[] {
  const issues: StartIssue[] = [];
  if (commands.length > max) issues.push({ key: 'listTooLong', what, max });
  commands.forEach((command, i) => {
    const problem = approvedCommandProblemCode(command);
    if (problem !== undefined) issues.push({ key: 'listLine', what, line: i + 1, problem });
  });
  if (new Set(commands).size !== commands.length) issues.push({ key: 'listDuplicate', what });
  return issues;
}

/** The same, in English. */
export function approvedListProblems(commands: readonly string[], what: 'commands' | 'checks', max = MAX_COMMANDS): string[] {
  return approvedListIssues(commands, what, max).map(startIssueText);
}

/**
 * One problem of a build's start (step 33): a code and its numbers, so the
 * start page says it in the user's language; `startIssueText` is the
 * English the server's error text uses.
 */
export type StartIssue =
  | { key: 'emptyQueue' }
  | { key: 'tooManyTasks'; max: number }
  | { key: 'taskInvalid'; n: number; fields: string[]; detail: string }
  | { key: 'laterDependency'; n: number }
  | { key: 'limit' }
  | { key: 'listTooLong'; what: 'commands' | 'checks'; max: number }
  | { key: 'listLine'; what: 'commands' | 'checks'; line: number; problem: CommandProblem }
  | { key: 'listDuplicate'; what: 'commands' | 'checks' }
  | { key: 'fixRounds'; max: number }
  | { key: 'slots'; max: number }
  | { key: 'threshold'; name: string }
  | { key: 'noChecks' };

export function startIssueText(issue: StartIssue): string {
  switch (issue.key) {
    case 'emptyQueue':
      return 'the queue is empty';
    case 'tooManyTasks':
      return `at most ${issue.max} tasks`;
    case 'taskInvalid':
      return `task ${issue.n}: ${issue.detail}`;
    case 'laterDependency':
      return `task ${issue.n}: it may depend only on earlier tasks`;
    case 'limit':
      return "how many tasks to run: from 1 to the queue's length";
    case 'listTooLong':
      return `${issue.what}: at most ${issue.max}`;
    case 'listLine':
      return `${issue.what} line ${issue.line}: ${COMMAND_PROBLEM_TEXT[issue.problem]}`;
    case 'listDuplicate':
      return `${issue.what}: the same command twice`;
    case 'fixRounds':
      return `fix rounds: 0 to ${issue.max}`;
    case 'slots':
      return `cards at once: 1 to ${issue.max}`;
    case 'threshold':
      return `usage threshold ${issue.name}: 1 to 100`;
    case 'noChecks':
      return 'no checks: confirm that every task with no denied command is then applied without any check';
  }
}

/** The parts of a chain of `&&`, `||` and `;`, split outside quotes, or `undefined` when the command is anything else. */
export function chainParts(command: string): string[] | undefined {
  const display = describeCommand(command);
  if (display.features.some((feature) => feature !== 'and' && feature !== 'or' && feature !== 'sequence')) return undefined;
  const parts: string[] = [];
  let quote: '"' | "'" | undefined;
  let start = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const width = (ch === '&' && next === '&') || (ch === '|' && next === '|') ? 2 : ch === ';' ? 1 : 0;
    if (width > 0) {
      parts.push(command.slice(start, i));
      start = i + width;
      i += width - 1;
    }
  }
  if (quote !== undefined) return undefined;
  parts.push(command.slice(start));
  const trimmed = parts.map(trimBlanks);
  return trimmed.some((part) => part === '') ? undefined : trimmed;
}

/** Whether a round may run `command` with the build's approved list. */
export function isApprovedCommand(command: string, approved: readonly string[]): boolean {
  if (approved.includes(command)) return true;
  const parts = chainParts(command);
  if (parts === undefined || parts.length < 2) return false;
  return parts.every((part) => approved.includes(part));
}

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

/** Why a command cannot be on the approved list, or `undefined`. */
export function approvedCommandProblem(command: string): string | undefined {
  if (command.trim() === '') return 'empty';
  if (command !== command.trim()) return 'spaces at the start or end';
  if (/[\r\n\0]/.test(command)) return 'more than one line';
  if (command.length > MAX_COMMAND_LENGTH) return `longer than ${MAX_COMMAND_LENGTH} characters`;
  // The same reading the task's dialog uses: a part that looks like a secret, or a character that hides text.
  if (redactSecretLines(command) !== command) return 'a part that looks like a secret';
  const display = describeCommand(command);
  if (display.features.includes('invisible')) return 'an invisible character';
  if (display.compound) return 'more than one command (list each part on its own)';
  if (/[*?[\]{}]/.test(command)) return 'a wildcard';
  // Only characters that no shell (sh, bash, cmd, PowerShell) reads as anything but text: a backslash, a bracket, `$`,
  // `%`, `^`, `!`, `~` or `#` could make one item several commands in one of them (review of M2, I1).
  if (!SAFE_ITEM_RE.test(command)) return 'a character other than letters, digits, spaces, quotes and - _ . / : = @ + ,';
  if ((command.match(/"/g)?.length ?? 0) % 2 !== 0 || (command.match(/'/g)?.length ?? 0) % 2 !== 0) return 'a quote that is not closed';
  return undefined;
}

/** What an approved item may hold. */
const SAFE_ITEM_RE = /^[A-Za-z0-9 _\-./:=@+,"']+$/;

/** Spaces and tabs only: not every character `String.trim` removes. */
const trimBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, '');

/** The problems of a whole list (`undefined` when it can be approved), each with its 1-based line. */
export function approvedListProblems(commands: readonly string[], what: 'commands' | 'checks', max = MAX_COMMANDS): string[] {
  const issues: string[] = [];
  if (commands.length > max) issues.push(`${what}: at most ${max}`);
  commands.forEach((command, i) => {
    const problem = approvedCommandProblem(command);
    if (problem !== undefined) issues.push(`${what} line ${i + 1}: ${problem}`);
  });
  if (new Set(commands).size !== commands.length) issues.push(`${what}: the same command twice`);
  return issues;
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

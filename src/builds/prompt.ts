import type { CheckResult, TaskValidation } from '../tasks/types.js';

/**
 * The first message of a build's round (BRIEF-phase-9 §3.3; PLAN-phase-9
 * §1, 4). The task's text comes from the approved queue (the user's
 * words, or the planner's as the user approved them); everything else is
 * fixed. The session is told nobody watches, which commands it may run,
 * and, in a fix round, why the last round did not apply. What it writes
 * back is shown as data.
 */

export interface BuildRoundInput {
  title: string;
  instruction: string;
  doneWhen: string;
  /** Its place in the queue and the queue's length. */
  n: number;
  total: number;
  /** The exact commands approved at the start. */
  commands: readonly string[];
  /** The checks that run after the round. */
  checks: readonly string[];
  lang: 'en' | 'es';
  /** A fix round: what failed in the round before. */
  fix?: { round: number; failures: string };
}

const list = (items: readonly string[]): string => (items.length === 0 ? '(none)' : items.map((item) => `- ${item}`).join('\n'));

export function buildRoundPrompt(input: BuildRoundInput): string {
  const lines = [
    `You are working on task ${input.n} of ${input.total} of a build, in a separate copy of an existing project (a git worktree). Nobody is watching this session: decide on your own and do not wait for answers.`,
    'Only change files inside this folder. Do not commit: briefstack commits your changes when you finish.',
    'Shell commands run only if they are exactly one of the commands below (or a chain of them with &&, || or ;); anything else, and every web request, is denied without asking anyone. Prefer reading and editing files.',
    'Approved commands:',
    list(input.commands),
    'After you finish, briefstack runs these checks; your changes are applied only if they all pass and no command was denied:',
    list(input.checks),
    `Write your final message in ${input.lang === 'es' ? 'Spanish' : 'English'}: a short summary of what you changed, what you decided on your own, and anything to check.`,
    '',
    `The task: ${input.title}`,
    input.instruction,
    '',
    'Done when:',
    input.doneWhen,
  ];
  if (input.fix !== undefined) {
    lines.push('', `This is fix round ${input.fix.round}. The changes of the earlier rounds are already in this folder, committed. They were not applied because:`, input.fix.failures);
  }
  return lines.join('\n');
}

const MAX_FAILURE_OUTPUT = 4000;

/** Why a round's change was not applied, as a fix round reads it: failed checks with the end of their output, denied commands, blocking validations. */
export function failureText(input: { checks?: readonly CheckResult[]; denied?: readonly { tool: string; text: string }[]; validations?: readonly TaskValidation[] }): string {
  const parts: string[] = [];
  for (const check of input.checks ?? []) {
    if (check.exitCode === 0 && !check.timedOut) continue;
    const how = check.timedOut ? 'timed out' : check.exitCode === null ? 'did not run' : `exited with ${check.exitCode}`;
    parts.push(`Check \`${check.command}\` ${how}. The end of its output:\n${check.output.slice(-MAX_FAILURE_OUTPUT)}`);
  }
  for (const entry of input.denied ?? []) parts.push(`Denied (${entry.tool}): ${entry.text}`);
  for (const item of (input.validations ?? []).filter((validation) => validation.level === 'error')) parts.push(`The server refused ${item.file} (${item.kind}).`);
  return parts.join('\n\n');
}

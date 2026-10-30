import { projectChecks, runChecks, type RunChecksOptions } from './checks.js';
import { BriefstackError } from '../errors.js';
import { headOf, isTaskWorktree, restoreToHead } from './git.js';
import type { AfterRoundResult } from './manager.js';
import type { TaskRecord } from './types.js';
import { validateTaskDiff } from './validate.js';

/**
 * What the server does after each round that ended (BRIEF-phase-7 §3.4):
 * the project's confirmed checks in the worktree, one after the other, then
 * the worktree put back to the round's commit (so nothing a check left can
 * reach the next round), then the validations of the whole diff.
 */
export function afterRoundWith(deps: { libraryDir: () => Promise<string>; home: string; checks?: RunChecksOptions }): (task: TaskRecord, worktree: string) => Promise<AfterRoundResult> {
  return async (task, worktree) => {
    const declared = await projectChecks({ libraryDir: await deps.libraryDir(), home: deps.home, slug: task.project }).catch(() => []);
    const commands = declared.filter((check) => check.confirmed).map((check) => check.command);
    const checks = commands.length === 0 ? [] : await runChecks(worktree, commands, deps.checks);
    // The checks ran project code: the server's git cleans up only a worktree that is still the task's.
    if (!(await isTaskWorktree(worktree, task.projectDir, task.branch))) throw new BriefstackError('task.worktreeChanged', { id: task.id });
    if (commands.length > 0) await restoreToHead(worktree);
    const head = await headOf(worktree);
    const validations = await validateTaskDiff(worktree, task.baseCommit, head);
    return { checks, validations, head };
  };
}

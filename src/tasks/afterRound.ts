import { headOf } from './git.js';
import type { AfterRoundResult } from './manager.js';
import type { TaskRecord } from './types.js';
import { validateTaskDiff } from './validate.js';

/**
 * What the server does after each round that ended (BRIEF-phase-7 §3.4):
 * the validations of the whole diff, which run no project code. The
 * declared checks do not run here: they run the code the session changed,
 * so they wait for the user to ask on the proposal page after reading the
 * diff (decisions.md, S8; `TaskManager.runChecks`).
 */
export function afterRoundWith(): (task: TaskRecord, worktree: string) => Promise<AfterRoundResult> {
  return async (task, worktree) => {
    const head = await headOf(worktree);
    const validations = await validateTaskDiff(worktree, task.baseCommit, head);
    return { validations, head };
  };
}

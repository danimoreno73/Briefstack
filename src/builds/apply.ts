import { BriefstackError, isBriefstackError } from '../errors.js';
import { assertLandingReady, land, recordInNote, type Landing } from '../tasks/apply.js';
import { runGit } from '../tasks/git.js';
import { redactSecretLines } from '../validate/secrets.js';
import { integrationHead } from './git.js';
import type { BuildRecord } from './types.js';

/**
 * Applying and reverting a whole build (BRIEF-phase-9 §2, 10 and §3.5;
 * PLAN-phase-9 §1, 13): one commit on the project's default branch with the
 * integration branch's whole change from the build's base, made as a task's
 * approval is (`merge-tree`, `commit-tree`, a compare and swap, then
 * `merge --ff-only` in the user's clean folder), with the same refusals.
 * Revert is one commit the other way. Nothing is pushed; hooks never run.
 */

export interface BuildApplyDeps {
  libraryDir: string;
  /** Something else at work on the project (a task or the build's own), by id. */
  busy: () => Promise<string | undefined>;
  now?: () => Date;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const oneLine = (text: string): string => redactSecretLines(text.trim().split(/\r?\n/, 1)[0] ?? '').trim();

function landingOf(build: BuildRecord): Landing {
  if (build.baseBranch === undefined || build.baseCommit === undefined) throw new BriefstackError('build.wrongState', { id: build.id, state: build.state });
  return { id: build.id, project: build.project, projectDir: build.projectDir, baseBranch: build.baseBranch };
}

/** The applied build's commit message: the tasks it holds, one per line. */
export function buildCommitMessage(build: BuildRecord): string {
  const applied = build.tasks.filter((task) => task.state === 'applied');
  const lines = applied.map((task) => `- ${clip(oneLine(task.title), 100)}${task.taskId === undefined ? '' : ` (task ${task.taskId})`}`);
  const subject = `Build ${build.id}: ${applied.length} task${applied.length === 1 ? '' : 's'} from the project's brief`;
  return `${subject}\n\n${lines.join('\n')}${lines.length > 0 ? '\n\n' : ''}Applied by briefstack from build ${build.id} (branch ${build.branch}).\n`;
}

/** Apply: one commit on the default branch with the integration branch's whole change. Returns the commit and when. */
export async function applyBuild(build: BuildRecord, deps: BuildApplyDeps): Promise<{ commit: string; at: string }> {
  const target = landingOf(build);
  const head = await integrationHead(build.projectDir, build.branch);
  if (head === undefined) throw new BriefstackError('build.branchMoved', { branch: build.branch });
  if (head === build.baseCommit) throw new BriefstackError('build.nothingToApply', { id: build.id });
  const branchHead = await assertLandingReady(target, deps.busy);
  let commit: string;
  try {
    commit = await land(target, build.baseCommit as string, head, buildCommitMessage(build), branchHead);
  } catch (error) {
    // The change is already all on the default branch.
    if (isBriefstackError(error) && error.code === 'task.noChanges') throw new BriefstackError('build.nothingToApply', { id: build.id });
    throw error;
  }
  const now = (deps.now ?? (() => new Date()))();
  const count = build.tasks.filter((task) => task.state === 'applied').length;
  await recordInNote(deps.libraryDir, build.project, `Build applied: ${count} task${count === 1 ? '' : 's'} (commit ${commit.slice(0, 7)}, build ${build.id}).`, now).catch(() => undefined);
  return { commit, at: now.toISOString() };
}

/** Revert: one commit that undoes the applied build's commit, under the same rules. */
export async function revertBuild(build: BuildRecord, deps: BuildApplyDeps): Promise<{ commit: string; at: string }> {
  if (build.state !== 'applied' || build.applied === undefined) throw new BriefstackError('build.wrongState', { id: build.id, state: build.state });
  const target = landingOf(build);
  const branchHead = await assertLandingReady(target, deps.busy);
  const applied = build.applied.commit;
  const parent = (await runGit(build.projectDir, ['rev-parse', '--verify', `${applied}^1`])).stdout.trim();
  if (parent === '') throw new BriefstackError('task.conflict', { project: build.project });
  const message = `Revert build ${build.id}\n\nReverted by briefstack: build ${build.id}, commit ${applied}.\n`;
  const commit = await land(target, applied, parent, message, branchHead);
  const now = (deps.now ?? (() => new Date()))();
  await recordInNote(deps.libraryDir, build.project, `Build reverted (commit ${commit.slice(0, 7)}, build ${build.id}).`, now).catch(() => undefined);
  return { commit, at: now.toISOString() };
}

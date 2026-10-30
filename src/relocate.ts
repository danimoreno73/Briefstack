import { stat } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath, readConfig, resolveHome, resolvePaths, updateConfig, type BriefstackConfig } from './config/config.js';
import { isPathInside, rewritePathPrefix, toAbsolute, type PathEnv } from './config/paths.js';
import { BriefstackError } from './errors.js';
import type { ProposalStatus } from './improve/proposal.js';
import { ImproveStore } from './improve/store.js';
import type { GitWarning } from './library/git.js';
import { toNative } from './library/layout.js';
import { libraryExists } from './library/notes.js';
import { rewriteProjectNotePaths } from './library/relocate.js';
import { rewriteAdditionalDirectories } from './library/settings.js';
import { tasksRoot, TaskStore } from './tasks/store.js';
import { isOpenTask, type TaskState } from './tasks/types.js';

/**
 * `briefstack paths rewrite`: after the user moved a folder, points what
 * briefstack keeps working with from the old place to the new one. That is
 * `projectsDir` and `libraryDir` in `config.json`, the `path` of each project
 * note (one library commit), the `projectDir` of each task (revert and the
 * diff use it) and the repo's `additionalDirectories`. Records of what
 * happened (session summaries, the creation log, chat threads, finished
 * improvements) keep the paths they had then. Without `apply` it writes
 * nothing.
 */

export interface PathRewrite {
  /** Absolute path of the file. */
  file: string;
  field: string;
  before: string;
  after: string;
}

export type RewriteNotice =
  /** `to` does not exist (a dry run only: `apply` refuses it). */
  | { kind: 'targetMissing'; dir: string }
  /** `BRIEFSTACK_LIBRARY` names a folder in `from`: an environment variable this command cannot change. */
  | { kind: 'libraryEnv'; value: string }
  | { kind: 'noLibrary'; dir: string }
  /** A task with a git worktree: moving its project or the home breaks the worktree's links. */
  | { kind: 'openTask'; id: string; project: string; state: TaskState }
  | { kind: 'openImprovement'; id: string; status: ProposalStatus }
  | { kind: 'git'; warning: GitWarning };

export interface RewriteReport {
  from: string;
  to: string;
  applied: boolean;
  changes: PathRewrite[];
  /** Each file in `changes`, once, in order. */
  files: string[];
  /** Whether the library commit was made. */
  committed: boolean;
  notices: RewriteNotice[];
}

const CLOSED_IMPROVEMENTS: readonly ProposalStatus[] = ['applied', 'reverted', 'discarded'];

/** Both folders, absolute; refused when either is relative or one is inside the other. */
export function rewriteFolders(fromArg: string, toArg: string, pathEnv: PathEnv): { from: string; to: string } {
  const from = toAbsolute(fromArg, pathEnv);
  if (from === undefined) throw new BriefstackError('config.relativePath', { source: '--from', value: fromArg });
  const to = toAbsolute(toArg, pathEnv);
  if (to === undefined) throw new BriefstackError('config.relativePath', { source: '--to', value: toArg });
  // Nested folders would rewrite twice over on a second run: `a` to `a/b`, then `a/b` to `a/b/b`.
  if (isPathInside(from, to, pathEnv) || isPathInside(to, from, pathEnv)) throw new BriefstackError('paths.overlapping', { from, to });
  return { from, to };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function rewritePaths(options: {
  pathEnv: PathEnv;
  /** The briefstack repo whose `.claude/settings.local.json` is rewritten. */
  repoDir: string;
  from: string;
  to: string;
  apply: boolean;
}): Promise<RewriteReport> {
  const { pathEnv, apply } = options;
  const { from, to } = rewriteFolders(options.from, options.to, pathEnv);
  const home = resolveHome(pathEnv);
  // The config lives in the home: read from the old place, it would look empty.
  if (isPathInside(home, from, pathEnv)) throw new BriefstackError('paths.homeNotMoved', { home, from });
  const notices: RewriteNotice[] = [];
  if (!(await isDirectory(to))) {
    if (apply) throw new BriefstackError('paths.targetMissing', { dir: to });
    notices.push({ kind: 'targetMissing', dir: to });
  }
  const changes: PathRewrite[] = [];

  const configFile = configFilePath(pathEnv);
  const config = await readConfig(configFile);
  const patch: Pick<BriefstackConfig, 'projectsDir' | 'libraryDir'> = {};
  for (const field of ['projectsDir', 'libraryDir'] as const) {
    const value = config[field];
    const after = value === undefined ? undefined : rewritePathPrefix(value, from, to, pathEnv);
    if (value === undefined || after === undefined) continue;
    patch[field] = after;
    changes.push({ file: configFile, field, before: value, after });
  }
  const libraryEnv = pathEnv.env.BRIEFSTACK_LIBRARY?.trim();
  if (libraryEnv !== undefined && libraryEnv !== '' && rewritePathPrefix(libraryEnv, from, to, pathEnv) !== undefined) {
    notices.push({ kind: 'libraryEnv', value: libraryEnv });
  }
  // Read now, so a settings file that does not parse stops everything before the first write.
  await rewriteAdditionalDirectories(options.repoDir, from, to, pathEnv, false);

  // The library where it is once the config names the new place.
  const { libraryDir } = resolvePaths({ ...config, ...patch }, pathEnv);
  let committed = false;
  if (await libraryExists(libraryDir)) {
    const notes = await rewriteProjectNotePaths({ libraryDir, from, to, pathEnv, apply });
    for (const change of notes.changes) changes.push({ file: toNative(libraryDir, change.file), field: 'path', before: change.before, after: change.after });
    committed = notes.committed;
    for (const warning of notes.warnings) notices.push({ kind: 'git', warning });
  } else {
    notices.push({ kind: 'noLibrary', dir: libraryDir });
  }

  if (apply && Object.keys(patch).length > 0) await updateConfig(configFile, patch);

  const tasks = new TaskStore(tasksRoot(home));
  for (const task of await tasks.list()) {
    if (isOpenTask(task.state)) notices.push({ kind: 'openTask', id: task.id, project: task.project, state: task.state });
    const after = rewritePathPrefix(task.projectDir, from, to, pathEnv);
    if (after === undefined) continue;
    changes.push({ file: tasks.recordFile(task.id), field: 'projectDir', before: task.projectDir, after });
    if (apply) await tasks.save({ ...task, projectDir: after });
  }
  for (const proposal of await new ImproveStore(path.join(home, 'improve')).list()) {
    if (!CLOSED_IMPROVEMENTS.includes(proposal.status)) notices.push({ kind: 'openImprovement', id: proposal.id, status: proposal.status });
  }

  const settings = await rewriteAdditionalDirectories(options.repoDir, from, to, pathEnv, apply);
  for (const change of settings.changes) changes.push({ file: settings.file, field: 'permissions.additionalDirectories', ...change });

  const files = [...new Set(changes.map((change) => change.file))];
  return { from, to, applied: apply, changes, files, committed, notices };
}

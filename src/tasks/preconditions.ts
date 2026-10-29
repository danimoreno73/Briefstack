import { stat } from 'node:fs/promises';
import { isFullyAbsolute, isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { noteRelativePath, toNative } from '../library/layout.js';
import { readTextIfExists } from '../library/notes.js';
import { readProjectStatus } from '../library/projectStatus.js';
import { protectedDirs } from '../scaffold/outputDir.js';
import { SLUG_RE } from '../spec/schema.js';
import { gitIsRecentEnough, gitVersion, initRepoWithCommit, repoState, uncommittedPaths, MIN_GIT_VERSION } from './git.js';
import { isOpenTask, type TaskRecord } from './types.js';

/**
 * The checks before a task starts (BRIEF-phase-7 §3.1), in this order, each
 * refused with its own coded error: the project is registered and created
 * by briefstack, `claude-code`, not archived, its folder exists and is out
 * of briefstack's own folders; git 2.38 or later; the folder is the top of
 * a git repository with a commit and a branch checked out; no other open
 * task on the project; no creation targets its folder; the active-sessions
 * limit allows one more.
 */

export interface ProjectForTask {
  slug: string;
  name: string;
  dir: string;
}

export interface TaskStartPoint extends ProjectForTask {
  /** The branch checked out in the project folder: the task's base branch. */
  branch: string;
  /** Its last commit: where the task starts. */
  head: string;
  /** Uncommitted paths in the project folder, which the task does not include (the page says so). */
  uncommitted: string[];
}

export interface PreconditionContext {
  libraryDir: string;
  repoDir: string;
  pathEnv?: PathEnv;
  /** Every task record (the open ones take their project). */
  tasks: () => Promise<readonly TaskRecord[]>;
  /** The label of the active creation whose folder overlaps `dir`, if any. */
  creationOn: (dir: string) => string | undefined | Promise<string | undefined>;
  /** Sessions active now (creations and tasks) and the shared limit. */
  active: () => Promise<{ count: number; limit: number; ids: string[] }>;
}

const firstHeading = (body: string): string | undefined => /^# +(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim() || undefined;

/** The project note's facts a task needs, or the coded refusal. */
export async function projectForTask(libraryDir: string, slug: string, pathEnv: PathEnv = systemPathEnv()): Promise<ProjectForTask> {
  if (!SLUG_RE.test(slug)) throw new BriefstackError('task.projectNotFound', { project: slug });
  const relative = noteRelativePath('projects', slug);
  const text = await readTextIfExists(toNative(libraryDir, relative));
  if (text === undefined) throw new BriefstackError('task.projectNotFound', { project: slug });
  const read = readProjectStatus(text, relative);
  if (!read.ok) throw new BriefstackError('library.invalidProjectStatus', { file: relative, issues: read.issues });
  const { status } = read;
  if (status.target !== 'claude-code') throw new BriefstackError('task.notClaudeCode', { project: slug, target: status.target });
  if (status.archived !== undefined) throw new BriefstackError('task.archived', { project: slug });
  if (!isFullyAbsolute(status.path, pathEnv.pathApi)) throw new BriefstackError('task.folderMissing', { project: slug, dir: status.path });
  const dir = pathEnv.pathApi.resolve(status.path);
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return { slug, name: firstHeading(body) ?? slug, dir };
}

/** The folder checks every task action shares: it exists, is out of briefstack's folders, and briefstack created it. */
async function assertProjectFolder(ctx: Pick<PreconditionContext, 'libraryDir' | 'repoDir'>, project: ProjectForTask, pathEnv: PathEnv): Promise<void> {
  const { slug, dir } = project;
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new BriefstackError('task.folderMissing', { project: slug, dir });
  }
  for (const held of protectedDirs(ctx.libraryDir, ctx.repoDir, pathEnv)) {
    if (isPathInside(dir, held.path, pathEnv) || isPathInside(held.path, dir, pathEnv)) {
      throw new BriefstackError('task.folderProtected', { project: slug, dir });
    }
  }
  try {
    if (!(await stat(pathEnv.pathApi.join(dir, '.briefstack', 'profile.json'))).isFile()) throw new Error('not a file');
  } catch {
    throw new BriefstackError('task.notFromBriefstack', { project: slug, dir });
  }
}

/**
 * The offer of BRIEF-phase-7 §3.1, after the user confirmed it: a project
 * folder that is not in any git repository becomes one, with one commit of
 * its current files. Refused for a folder inside another repository.
 */
export async function initProjectRepo(ctx: Pick<PreconditionContext, 'libraryDir' | 'repoDir' | 'pathEnv'>, slug: string): Promise<{ commit: string }> {
  const pathEnv = ctx.pathEnv ?? systemPathEnv();
  const project = await projectForTask(ctx.libraryDir, slug, pathEnv);
  await assertProjectFolder(ctx, project, pathEnv);
  const version = await gitVersion();
  if (version === undefined) throw new BriefstackError('task.gitMissing', {});
  const repo = await repoState(project.dir);
  if (repo.inRepo) throw new BriefstackError(repo.isTop ? 'task.alreadyRepo' : 'task.insideOtherRepo', { project: slug });
  return { commit: await initRepoWithCommit(project.dir) };
}

/** Throws the first precondition that fails; otherwise where the task starts. */
export async function checkTaskPreconditions(ctx: PreconditionContext, slug: string): Promise<TaskStartPoint> {
  const pathEnv = ctx.pathEnv ?? systemPathEnv();
  const project = await projectForTask(ctx.libraryDir, slug, pathEnv);
  const { dir } = project;
  await assertProjectFolder(ctx, project, pathEnv);

  const version = await gitVersion();
  if (version === undefined) throw new BriefstackError('task.gitMissing', {});
  if (!gitIsRecentEnough(version)) throw new BriefstackError('task.gitTooOld', { version: version.text, required: MIN_GIT_VERSION.join('.') });

  const repo = await repoState(dir);
  if (!repo.inRepo) throw new BriefstackError('task.notGitRepo', { project: slug });
  if (!repo.isTop) throw new BriefstackError('task.insideOtherRepo', { project: slug });
  if (repo.head === undefined) throw new BriefstackError('task.noCommit', { project: slug });
  if (repo.branch === undefined) throw new BriefstackError('task.detachedHead', { project: slug });

  const open = (await ctx.tasks()).find((task) => task.project === slug && isOpenTask(task.state));
  if (open !== undefined) throw new BriefstackError('task.projectBusy', { project: slug, id: open.id });
  const holder = await ctx.creationOn(dir);
  if (holder !== undefined) throw new BriefstackError('task.creationOnFolder', { project: slug, holder });
  const active = await ctx.active();
  if (active.count >= active.limit) throw new BriefstackError('task.limit', { limit: active.limit, active: active.ids });

  return { ...project, branch: repo.branch, head: repo.head, uncommitted: await uncommittedPaths(dir) };
}

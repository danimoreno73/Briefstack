import type { PathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { addNote } from '../library/notes.js';
import { listProjects } from '../library/projects.js';
import { hasGitSegment, insideAny } from '../creation/guard.js';
import { protectedDirs, realpathNearest } from '../scaffold/outputDir.js';
import { checkProjectDir, chooseInSpec, installSkills, readInstalled, type InstalledSkill } from './install.js';
import type { SkillService } from './service.js';

/**
 * Adds an approved library skill to an existing project (BRIEF-phase-6
 * §3.5): the same install as `briefstack skills install --skill`, then one
 * dated line in the project's library note. The project is found by its
 * note, so only folders briefstack created are touched.
 */

export interface ProjectTarget {
  slug: string;
  name: string;
  dir: string;
  target: string;
}

/** The project a slug names, from its library note. */
export async function projectTarget(libraryDir: string, slug: string): Promise<ProjectTarget> {
  const project = (await listProjects(libraryDir)).find((p) => p.slug === slug);
  if (project?.status === undefined) throw new BriefstackError('library.noteNotFound', { section: 'projects', name: slug });
  return { slug, name: project.name, dir: project.status.path, target: project.status.target };
}

/** Where `skills install` puts a skill in a project of `target`. */
export const installLocation = (target: string, name: string): string => (target === 'claude-app' ? `skills/${name}.zip` : `.claude/skills/${name}`);

export async function isInstalled(dir: string, name: string): Promise<boolean> {
  try {
    return (await readInstalled(dir)).some((entry) => entry.name === name);
  } catch {
    return false;
  }
}

/**
 * Where a project's install may go, with the creation guard's rules: never
 * a protected folder or a `.git` folder, and inside the projects folder
 * unless the user granted that folder (the card did, for this install).
 * Returns the folder resolved and whether it is outside the projects folder.
 */
export async function checkInstallFolder(options: {
  dir: string;
  libraryDir: string;
  repoDir: string;
  projectsDir: string;
  pathEnv: PathEnv;
  /** A folder the user granted for this install. */
  granted?: string | undefined;
}): Promise<{ dir: string; outsideProjects: boolean }> {
  const dir = await checkProjectDir(options.dir, protectedDirs(options.libraryDir, options.repoDir, options.pathEnv));
  let real: string;
  try {
    real = await realpathNearest(dir);
  } catch {
    real = dir;
  }
  if (hasGitSegment(dir) || hasGitSegment(real)) throw new BriefstackError('skills.outsideProjects', { dir });
  const outsideProjects = !(await insideAny(dir, [options.projectsDir], options.pathEnv));
  if (outsideProjects && !(options.granted !== undefined && (await insideAny(dir, [options.granted], options.pathEnv)))) {
    throw new BriefstackError('skills.outsideProjects', { dir });
  }
  return { dir, outsideProjects };
}

export async function addSkillToProject(options: {
  skills: SkillService;
  libraryDir: string;
  repoDir: string;
  projectsDir: string;
  pathEnv: PathEnv;
  slug: string;
  skill: string;
  /** The folder the user granted on the card, when the project is outside the projects folder. */
  granted?: string | undefined;
}): Promise<{ project: ProjectTarget; installed: InstalledSkill; note: string }> {
  const project = await projectTarget(options.libraryDir, options.slug);
  const forbidden = protectedDirs(options.libraryDir, options.repoDir, options.pathEnv);
  const { dir } = await checkInstallFolder({ ...options, dir: project.dir });
  if (await isInstalled(dir, options.skill)) throw new BriefstackError('skills.alreadyInstalled', { name: options.skill });
  // The user chose it on the card: it joins the project's spec, so the install (and the validator) accept it.
  const restoreSpec = await chooseInSpec(dir, options.skill);
  let result;
  try {
    result = await installSkills({ projectDir: dir, skills: options.skills, only: options.skill, protectedDirs: forbidden });
  } catch (error) {
    await restoreSpec();
    throw error;
  }
  const installed = result.installed[0];
  if (installed === undefined) throw new BriefstackError('skills.alreadyInstalled', { name: options.skill });
  const where = installed.path === '' ? installed.repo : `${installed.repo} ${installed.path}`;
  const saved = await addNote({
    libraryDir: options.libraryDir,
    section: 'projects',
    name: project.slug,
    text: `Library skill \`${installed.name}\` added in \`${installed.location}\`, from ${where} at commit \`${installed.commit.slice(0, 7)}\`.\n`,
  });
  return { project, installed, note: saved.file };
}

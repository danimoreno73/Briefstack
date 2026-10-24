import type { PathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { addNote } from '../library/notes.js';
import { listProjects } from '../library/projects.js';
import { protectedDirs } from '../scaffold/outputDir.js';
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

export async function addSkillToProject(options: {
  skills: SkillService;
  libraryDir: string;
  repoDir: string;
  pathEnv: PathEnv;
  slug: string;
  skill: string;
}): Promise<{ project: ProjectTarget; installed: InstalledSkill; note: string }> {
  const project = await projectTarget(options.libraryDir, options.slug);
  const forbidden = protectedDirs(options.libraryDir, options.repoDir, options.pathEnv);
  const dir = await checkProjectDir(project.dir, forbidden);
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

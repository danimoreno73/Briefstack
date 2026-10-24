import type { PathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { addNote } from '../library/notes.js';
import { listProjects } from '../library/projects.js';
import { protectedDirs } from '../scaffold/outputDir.js';
import { installSkills, readInstalled, type InstalledSkill } from './install.js';
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
  const result = await installSkills({
    projectDir: project.dir,
    skills: options.skills,
    only: options.skill,
    protectedDirs: protectedDirs(options.libraryDir, options.repoDir, options.pathEnv),
  });
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

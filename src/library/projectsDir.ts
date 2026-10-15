import { mkdir, stat } from 'node:fs/promises';
import { configFilePath, readConfig, resolvePaths, updateConfig } from '../config/config.js';
import { toAbsolute, type PathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { inspectOutputDir, protectedDirs, type ProtectedDir } from '../scaffold/outputDir.js';
import { prepareAdditionalDirectories, writePreparedDirectories, type AddDirectoryResult } from './settings.js';

export interface SetProjectsDirOptions {
  pathEnv: PathEnv;
  /** The briefstack repo whose `.claude/settings.local.json` gets the folder; the package by default. */
  repoDir?: string | undefined;
  /** Absolute, or starting with `~`. */
  dir: string;
}

export interface SetProjectsDirResult {
  /** The projects folder before the change. */
  previous: string;
  projectsDir: string;
  configFile: string;
  /** Whether `config.json` was rewritten (false when it already named this folder). */
  configChanged: boolean;
  /** Whether the folder had to be created. */
  created: boolean;
  /** The `additionalDirectories` entry, added or already there. */
  settings: AddDirectoryResult[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Changes where new projects go (doubt 6): saves `projectsDir` in the
 * config, creates the folder, and adds it to the repo's
 * `permissions.additionalDirectories` with the merge `init` uses. The old
 * folder's entry is kept: projects already created there stay reachable.
 * A relative path, a folder that overlaps the repo or the library (the
 * check `paths check` runs), a file, or an invalid settings file stops it
 * before anything is written. A folder that does not exist yet is fine: it is
 * created.
 */
export async function setProjectsDir(options: SetProjectsDirOptions): Promise<SetProjectsDirResult> {
  const { pathEnv } = options;
  const projectsDir = toAbsolute(options.dir, pathEnv);
  if (projectsDir === undefined) throw new BriefstackError('config.relativePath', { source: 'projectsDir', value: options.dir });

  const configFile = configFilePath(pathEnv);
  const config = await readConfig(configFile);
  const { projectsDir: previous, libraryDir } = resolvePaths(config, pathEnv);
  const repoDir = options.repoDir ?? PACKAGE_ROOT;
  // The same check as `briefstack paths check`: not inside or around the repo or the library, and not a file.
  const report = await inspectOutputDir(projectsDir, protectedDirs(libraryDir, repoDir, pathEnv));
  if (report.status === 'forbidden') {
    const { root, path: rootPath } = report.overlaps as ProtectedDir;
    throw new BriefstackError('scaffold.forbiddenOutput', { outDir: report.outDir, root, rootPath });
  }
  if (report.status === 'notADirectory') throw new BriefstackError('scaffold.notADirectory', { outDir: report.outDir });
  const prepared = await prepareAdditionalDirectories(repoDir, [projectsDir], pathEnv);

  const configChanged = config.projectsDir !== projectsDir;
  if (configChanged) await updateConfig(configFile, { projectsDir });
  const created = !(await exists(projectsDir));
  if (created) await mkdir(projectsDir, { recursive: true });
  const settings = await writePreparedDirectories(prepared);
  return { previous, projectsDir, configFile, configChanged, created, settings };
}

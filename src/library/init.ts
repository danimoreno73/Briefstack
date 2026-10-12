import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PathEnv } from '../config/paths.js';
import { gitCommit, gitInit, type GitWarning } from './git.js';
import {
  INDEX_FILE,
  INDEX_TEMPLATE,
  LESSONS_FILE,
  LESSONS_TEMPLATE,
  LIBRARY_FOLDERS,
  LOG_INDEX_FILE,
  LOG_INDEX_TEMPLATE,
  toNative,
} from './layout.js';
import { prepareAdditionalDirectory, writePreparedDirectory, type AddDirectoryResult } from './settings.js';

export interface InitOptions {
  libraryDir: string;
  projectsDir: string;
  /** The briefstack repo whose `.claude/settings.local.json` gets `projectsDir`. */
  repoDir: string;
  pathStyle?: Pick<PathEnv, 'pathApi' | 'caseInsensitive'>;
}

export interface InitResult {
  libraryDir: string;
  /** Created inside the library, relative with `/` (folders end with `/`). */
  created: string[];
  gitInitialised: boolean;
  committed: boolean;
  projectsDir: string;
  projectsDirCreated: boolean;
  settings: AddDirectoryResult;
  warnings: GitWarning[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string): Promise<boolean> {
  if (await exists(dir)) return false;
  await mkdir(dir, { recursive: true });
  return true;
}

/** Writes `text` unless the file exists. Never overwrites. */
async function ensureFile(file: string, text: string): Promise<boolean> {
  try {
    await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Creates the personal library, the projects folder and the
 * `additionalDirectories` entry. Idempotent: existing files are never
 * touched and a second run changes nothing. The settings file is checked
 * first, so invalid JSON there stops `init` before anything is created.
 */
export async function initLibrary(options: InitOptions): Promise<InitResult> {
  const { libraryDir, projectsDir } = options;
  const warnings: GitWarning[] = [];
  const prepared = await prepareAdditionalDirectory(options.repoDir, projectsDir, options.pathStyle);

  const created: string[] = [];
  if (await ensureDir(libraryDir)) created.push('./');
  for (const folder of LIBRARY_FOLDERS) {
    if (await ensureDir(path.join(libraryDir, folder))) created.push(`${folder}/`);
  }
  const files: [string, string][] = [
    [INDEX_FILE, INDEX_TEMPLATE],
    [LESSONS_FILE, LESSONS_TEMPLATE],
    [LOG_INDEX_FILE, LOG_INDEX_TEMPLATE],
  ];
  const createdFiles: string[] = [];
  for (const [relative, text] of files) {
    if (await ensureFile(toNative(libraryDir, relative), text)) createdFiles.push(relative);
  }
  created.push(...createdFiles);

  const git = await gitInit(libraryDir);
  if (git.warning !== undefined) warnings.push(git.warning);
  let committed = false;
  if (git.warning === undefined) {
    const commit = await gitCommit(libraryDir, createdFiles, 'library: initialise');
    committed = commit.committed;
    if (commit.warning !== undefined) warnings.push(commit.warning);
  }

  const projectsDirCreated = await ensureDir(projectsDir);
  const settings = await writePreparedDirectory(prepared);

  return {
    libraryDir,
    created,
    gitInitialised: git.initialised,
    committed,
    projectsDir,
    projectsDirCreated,
    settings,
    warnings,
  };
}

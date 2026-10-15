import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { BriefstackError, type ProtectedRoot } from '../errors.js';
import { PACKAGE_ROOT } from '../packageRoot.js';

export interface ProtectedDir {
  root: ProtectedRoot;
  path: string;
}

/** Folders a generated project, or the projects folder, must not overlap. */
export const protectedDirs = (libraryDir: string, repoDir: string = PACKAGE_ROOT): ProtectedDir[] => [
  { root: 'repo', path: repoDir },
  { root: 'library', path: libraryDir },
];

/** `realpath` of the deepest existing ancestor, with the missing tail re-appended. */
export async function realpathNearest(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export interface OutputDirState {
  /** Absolute output directory as given (not resolved through symlinks). */
  outDir: string;
  existed: boolean;
}

/** What `scaffold` would find in an output directory. */
export type OutputDirStatus = 'missing' | 'empty' | 'nonEmpty' | 'notADirectory' | 'forbidden';

export interface OutputDirReport {
  /** Absolute output directory as given (not resolved through symlinks). */
  outDir: string;
  status: OutputDirStatus;
  /** The protected folder it overlaps, when `status` is `forbidden`. */
  overlaps?: ProtectedDir;
}

/**
 * Inspects an output directory without changing anything. Overlap with a
 * protected folder is checked either way round, after `realpath`.
 */
export async function inspectOutputDir(
  outDir: string,
  protectedDirs: readonly ProtectedDir[],
): Promise<OutputDirReport> {
  const absolute = path.resolve(outDir);
  const realOut = await realpathNearest(absolute);
  const pathEnv = systemPathEnv();

  for (const dir of protectedDirs) {
    const realRoot = await realpathNearest(dir.path);
    if (isPathInside(realOut, realRoot, pathEnv) || isPathInside(realRoot, realOut, pathEnv)) {
      return { outDir: absolute, status: 'forbidden', overlaps: dir };
    }
  }

  let isDirectory: boolean;
  try {
    isDirectory = (await stat(absolute)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { outDir: absolute, status: 'missing' };
    throw error;
  }
  if (!isDirectory) return { outDir: absolute, status: 'notADirectory' };
  return { outDir: absolute, status: (await readdir(absolute)).length > 0 ? 'nonEmpty' : 'empty' };
}

/**
 * Refuses an output directory that overlaps a protected folder, that is a
 * file, or that is a non-empty folder unless `allowNonEmpty` is set.
 */
export async function checkOutputDir(
  outDir: string,
  protectedDirs: readonly ProtectedDir[],
  allowNonEmpty: boolean,
): Promise<OutputDirState> {
  const report = await inspectOutputDir(outDir, protectedDirs);
  const absolute = report.outDir;
  switch (report.status) {
    case 'forbidden': {
      const dir = report.overlaps as ProtectedDir;
      throw new BriefstackError('scaffold.forbiddenOutput', { outDir: absolute, root: dir.root, rootPath: dir.path });
    }
    case 'notADirectory':
      throw new BriefstackError('scaffold.notADirectory', { outDir: absolute });
    case 'nonEmpty':
      if (!allowNonEmpty) throw new BriefstackError('scaffold.nonEmptyOutput', { outDir: absolute });
      return { outDir: absolute, existed: true };
    case 'empty':
      return { outDir: absolute, existed: true };
    case 'missing':
      return { outDir: absolute, existed: false };
  }
}

/** Relative paths (with `/`) from `paths` that already exist under `outDir`. */
export async function existingPaths(outDir: string, paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const relative of paths) {
    try {
      await lstat(path.join(outDir, ...relative.split('/')));
      found.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found;
}

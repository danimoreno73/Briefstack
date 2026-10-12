import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { BriefstackError, type ProtectedRoot } from '../errors.js';

export interface ProtectedDir {
  root: ProtectedRoot;
  path: string;
}

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

/**
 * Refuses an output directory that overlaps a protected folder (either way
 * round, compared after `realpath`), that is a file, or that is a non-empty
 * folder unless `allowNonEmpty` is set.
 */
export async function checkOutputDir(
  outDir: string,
  protectedDirs: readonly ProtectedDir[],
  allowNonEmpty: boolean,
): Promise<OutputDirState> {
  const absolute = path.resolve(outDir);
  const realOut = await realpathNearest(absolute);
  const pathEnv = systemPathEnv();

  for (const dir of protectedDirs) {
    const realRoot = await realpathNearest(dir.path);
    if (isPathInside(realOut, realRoot, pathEnv) || isPathInside(realRoot, realOut, pathEnv)) {
      throw new BriefstackError('scaffold.forbiddenOutput', {
        outDir: absolute,
        root: dir.root,
        rootPath: dir.path,
      });
    }
  }

  let isDirectory: boolean;
  try {
    isDirectory = (await stat(absolute)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { outDir: absolute, existed: false };
    throw error;
  }
  if (!isDirectory) throw new BriefstackError('scaffold.notADirectory', { outDir: absolute });
  if (!allowNonEmpty && (await readdir(absolute)).length > 0) {
    throw new BriefstackError('scaffold.nonEmptyOutput', { outDir: absolute });
  }
  return { outDir: absolute, existed: true };
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

import os from 'node:os';
import path from 'node:path';

/**
 * Everything path resolution depends on. Tests pass `path.win32` or
 * `path.posix` with a matching home directory to cover both styles.
 */
export interface PathEnv {
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  pathApi: path.PlatformPath;
  /** Whether paths compare case-insensitively (Windows and macOS). */
  caseInsensitive: boolean;
}

export function systemPathEnv(): PathEnv {
  return {
    env: process.env,
    homedir: os.homedir(),
    pathApi: path,
    caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
  };
}

/** Expands a leading `~` (followed by `/`, `\` or nothing) to the home directory. */
export function expandHome(value: string, pathEnv: Pick<PathEnv, 'homedir' | 'pathApi'>): string {
  if (value === '~') return pathEnv.homedir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return pathEnv.pathApi.join(pathEnv.homedir, value.slice(2));
  }
  return value;
}

/**
 * Whether `value` is a complete absolute path. On Windows that means a drive
 * (`C:\`, `C:/`) or a UNC share (`\\server\share`). A rooted path without a
 * drive, such as `\data` or a Git Bash `/c/Users/...` that reached a Windows
 * program unconverted, is refused: Node would resolve it against the current
 * drive (`C:\c\Users\...`), a folder nobody asked for (`decisions.md`, H8).
 */
export function isFullyAbsolute(value: string, pathApi: PathEnv['pathApi']): boolean {
  if (!pathApi.isAbsolute(value)) return false;
  if (pathApi.sep !== '\\') return true;
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(value);
}

/**
 * Expands `~` and normalises. Returns `undefined` when the result is not
 * fully absolute, so callers can reject it with their own error.
 */
export function toAbsolute(
  value: string,
  pathEnv: Pick<PathEnv, 'homedir' | 'pathApi'>,
): string | undefined {
  const expanded = expandHome(value.trim(), pathEnv);
  if (!isFullyAbsolute(expanded, pathEnv.pathApi)) return undefined;
  return pathEnv.pathApi.resolve(expanded);
}

/**
 * True when `child` is `parent` or lies inside it. Both must already be
 * absolute; resolve symlinks with `realpath` before calling when that matters.
 * `path.win32` already compares case-insensitively; `caseInsensitive` adds
 * the same for macOS.
 */
export function isPathInside(
  child: string,
  parent: string,
  pathEnv: Pick<PathEnv, 'pathApi' | 'caseInsensitive'>,
): boolean {
  const { pathApi, caseInsensitive } = pathEnv;
  let from = pathApi.resolve(parent);
  let to = pathApi.resolve(child);
  if (caseInsensitive) {
    from = from.toLowerCase();
    to = to.toLowerCase();
  }
  const relative = pathApi.relative(from, to);
  if (relative === '') return true;
  if (pathApi.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
}

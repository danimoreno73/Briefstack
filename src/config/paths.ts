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
 * Expands `~` and normalises. Returns `undefined` when the result is not
 * absolute, so callers can reject relative paths with their own error.
 */
export function toAbsolute(
  value: string,
  pathEnv: Pick<PathEnv, 'homedir' | 'pathApi'>,
): string | undefined {
  const expanded = expandHome(value.trim(), pathEnv);
  if (!pathEnv.pathApi.isAbsolute(expanded)) return undefined;
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

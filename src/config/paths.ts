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

/**
 * `value` with its leading folder `from` replaced by `to`, for a folder that
 * moved; `undefined` when `value` is not `from` or inside it (a relative
 * value, or a folder that only starts with the same letters, such as
 * `projects-old` for `projects`). `from` and `to` must be absolute. Case and
 * separators compare the way the system's paths do; a value written with
 * `/` only keeps `/` on Windows.
 */
export function rewritePathPrefix(
  value: string,
  from: string,
  to: string,
  pathEnv: Pick<PathEnv, 'homedir' | 'pathApi' | 'caseInsensitive'>,
): string | undefined {
  const { pathApi } = pathEnv;
  const absolute = toAbsolute(value, pathEnv);
  if (absolute === undefined) return undefined;
  const base = pathApi.resolve(from);
  if (!isPathInside(absolute, base, pathEnv)) return undefined;
  // Both are resolved and `absolute` is inside `base`: the rest follows its length, in its own case.
  const rest = absolute.slice(base.length).replace(/^[\\/]+/, '');
  const moved = rest === '' ? pathApi.resolve(to) : pathApi.join(pathApi.resolve(to), rest);
  return pathApi.sep === '\\' && !value.includes('\\') ? moved.replace(/\\/g, '/') : moved;
}

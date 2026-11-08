import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * How briefstack starts the user's Codex CLI, with no shell (decisions.md,
 * "Phase 8: Codex spike"). On Windows npm installs `codex.cmd`, which needs
 * a shell, so briefstack runs the package's own launcher with the Node that
 * runs briefstack: `node <npm prefix>/node_modules/@openai/codex/bin/codex.js`.
 * Elsewhere, `codex` from the PATH.
 */
export interface CodexCommand {
  /** The program spawned. */
  file: string;
  /** Arguments before Codex's own (the launcher on Windows). */
  prefix: string[];
}

export interface FindCodexOptions {
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** Injected in tests. */
  exists?: (file: string) => boolean;
  /** The Node that runs the launcher on Windows. Default this process's. */
  execPath?: string;
}

/** The PATH's value, whatever its name's case (`Path` on Windows). */
function pathValue(env: Readonly<Record<string, string | undefined>>): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : (env[key] ?? '');
}

/** Codex as installed for the user, or `undefined` when it is not on the PATH. */
export function findCodex(options: FindCodexOptions): CodexCommand | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathValue(options.env)
    .split(platform === 'win32' ? ';' : ':')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && api.isAbsolute(dir));
  for (const dir of dirs) {
    if (platform === 'win32') {
      if (!exists(api.join(dir, 'codex.cmd'))) continue;
      const launcher = api.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (exists(launcher)) return { file: options.execPath ?? process.execPath, prefix: [launcher] };
    } else {
      const file = api.join(dir, 'codex');
      if (exists(file)) return { file, prefix: [] };
    }
  }
  return undefined;
}

import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The user's installed Claude Code, which creation sessions run through the
 * Agent SDK (`pathToClaudeCodeExecutable`), and its compatibility with the
 * pinned SDK. The SDK does not document a rule; ours (decisions.md):
 * same major.minor as the SDK's `claudeCodeVersion` and not older is
 * compatible, anything else gets a warning.
 */

const execFileAsync = promisify(execFile);

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const formatVersion = (v: Version): string => v.join('.');

export type Compatibility = 'compatible' | 'older' | 'untested';

export function compatibility(installed: Version, expected: Version): Compatibility {
  if (installed[0] !== expected[0] || installed[1] !== expected[1]) {
    const older = installed[0] < expected[0] || (installed[0] === expected[0] && installed[1] < expected[1]);
    return older ? 'older' : 'untested';
  }
  return installed[2] >= expected[2] ? 'compatible' : 'older';
}

/** The Claude Code version the pinned SDK was built with (its package.json `claudeCodeVersion`). */
export function sdkClaudeCodeVersion(): Version | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as {
      claudeCodeVersion?: string;
    };
    return pkg.claudeCodeVersion === undefined ? undefined : parseVersion(pkg.claudeCodeVersion);
  } catch {
    return undefined;
  }
}

export interface ExecutableSearch {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  pathApi?: path.PlatformPath;
  /** Injected in tests; defaults to a real file check. */
  isFile?: (file: string) => boolean;
}

const realIsFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Finds `claude` on PATH, then in `~/.local/bin` (the native installer's
 * folder). On Windows only `claude.exe` counts: the SDK refuses `.cmd` and
 * `.bat` shims such as npm's `claude.cmd`.
 */
export function findClaudeExecutable(search: ExecutableSearch): string | undefined {
  const pathApi = search.pathApi ?? (search.platform === 'win32' ? path.win32 : path.posix);
  const isFile = search.isFile ?? realIsFile;
  const name = search.platform === 'win32' ? 'claude.exe' : 'claude';
  const pathVar = search.env.PATH ?? search.env.Path ?? '';
  const dirs = pathVar.split(search.platform === 'win32' ? ';' : ':').filter((dir) => dir.trim() !== '');
  dirs.push(pathApi.join(search.homedir, '.local', 'bin'));
  for (const dir of dirs) {
    const candidate = pathApi.join(dir.trim(), name);
    if (pathApi.isAbsolute(candidate) && isFile(candidate)) return candidate;
  }
  return undefined;
}

export type ClaudeCheck =
  | { status: 'compatible'; executable: string; installed: Version; expected: Version }
  | { status: 'older' | 'untested'; executable: string; installed: Version; expected: Version }
  | { status: 'notFound' }
  | { status: 'unknownVersion'; executable: string };

/** Locates the installed Claude Code and compares its version with the SDK's. */
export async function checkClaudeCode(
  search: ExecutableSearch,
  run: (file: string, args: string[]) => Promise<string> = async (file, args) =>
    (await execFileAsync(file, args, { timeout: 15_000, windowsHide: true })).stdout,
  expected: Version | undefined = sdkClaudeCodeVersion(),
): Promise<ClaudeCheck> {
  const executable = findClaudeExecutable(search);
  if (executable === undefined) return { status: 'notFound' };
  let installed: Version | undefined;
  try {
    installed = parseVersion(await run(executable, ['--version']));
  } catch {
    installed = undefined;
  }
  if (installed === undefined || expected === undefined) return { status: 'unknownVersion', executable };
  return { status: compatibility(installed, expected), executable, installed, expected };
}

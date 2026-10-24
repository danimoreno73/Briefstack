import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError, type FieldExpectation } from '../errors.js';
import { isLang, type Lang } from '../i18n/index.js';
import { DEFAULT_MAX_ACTIVE_CREATIONS, DEFAULT_USAGE_WARN_FIVE_HOUR, DEFAULT_USAGE_WARN_WEEK } from './limits.js';
import { toAbsolute, type PathEnv } from './paths.js';

/**
 * What a web creation does with a permission request: ask the user in the
 * browser, or deny it and record the denial (unattended runs).
 */
export const PERMISSION_POLICIES = ['ask', 'unattended'] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = 'ask';

export function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  return typeof value === 'string' && (PERMISSION_POLICIES as readonly string[]).includes(value);
}

export { DEFAULT_MAX_ACTIVE_CREATIONS, DEFAULT_USAGE_WARN_FIVE_HOUR, DEFAULT_USAGE_WARN_WEEK, MANY_CREATIONS_NOTE_ABOVE } from './limits.js';


/** Contents of `<briefstack home>/config.json`. Every field is optional. */
export interface BriefstackConfig {
  activeProfile?: string;
  libraryDir?: string;
  projectsDir?: string;
  lang?: Lang;
  /** Absent means `ask`. */
  permissionPolicy?: PermissionPolicy;
  /** A whole number from 1 up; absent means `DEFAULT_MAX_ACTIVE_CREATIONS`. */
  maxActiveCreations?: number;
  /** Percent of the 5-hour window above which a start shows a warning; absent means the default. */
  usageWarnFiveHour?: number;
  /** Percent of the week above which a start shows a warning; absent means the default. */
  usageWarnWeek?: number;
}

/** The thresholds of the plan-usage warning. */
export function usageWarningOf(config: BriefstackConfig): { fiveHour: number; week: number } {
  return { fiveHour: config.usageWarnFiveHour ?? DEFAULT_USAGE_WARN_FIVE_HOUR, week: config.usageWarnWeek ?? DEFAULT_USAGE_WARN_WEEK };
}

export function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100;
}

/** The config's permission policy, `ask` when it sets none. */
export function permissionPolicyOf(config: BriefstackConfig): PermissionPolicy {
  return config.permissionPolicy ?? DEFAULT_PERMISSION_POLICY;
}

/** The config's limit of active creations, the default when it sets none. */
export function maxActiveCreationsOf(config: BriefstackConfig): number {
  return config.maxActiveCreations ?? DEFAULT_MAX_ACTIVE_CREATIONS;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export interface ResolvedPaths {
  /** `BRIEFSTACK_HOME`, or `~/.briefstack`. */
  home: string;
  configFile: string;
  /** User usage presets, merged over the base ones by name. */
  userProfilesFile: string;
  sessionsDir: string;
  /** `BRIEFSTACK_LIBRARY` > config `libraryDir` > `<home>/library`. */
  libraryDir: string;
  /** Config `projectsDir` > `~/briefstack-projects`. */
  projectsDir: string;
}

const CONFIG_FILE = 'config.json';

function absoluteOrThrow(value: string, source: string, pathEnv: PathEnv): string {
  const resolved = toAbsolute(value, pathEnv);
  if (resolved === undefined) {
    throw new BriefstackError('config.relativePath', { source, value });
  }
  return resolved;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** Briefstack's own folder. Needed before the config can be read. */
export function resolveHome(pathEnv: PathEnv): string {
  const fromEnv = nonEmpty(pathEnv.env.BRIEFSTACK_HOME);
  if (fromEnv !== undefined) return absoluteOrThrow(fromEnv, 'BRIEFSTACK_HOME', pathEnv);
  return pathEnv.pathApi.join(pathEnv.homedir, '.briefstack');
}

export function configFilePath(pathEnv: PathEnv): string {
  return pathEnv.pathApi.join(resolveHome(pathEnv), CONFIG_FILE);
}

export function resolvePaths(config: BriefstackConfig, pathEnv: PathEnv): ResolvedPaths {
  const { pathApi } = pathEnv;
  const home = resolveHome(pathEnv);

  const libraryFromEnv = nonEmpty(pathEnv.env.BRIEFSTACK_LIBRARY);
  const libraryDir =
    libraryFromEnv !== undefined
      ? absoluteOrThrow(libraryFromEnv, 'BRIEFSTACK_LIBRARY', pathEnv)
      : config.libraryDir !== undefined
        ? absoluteOrThrow(config.libraryDir, 'libraryDir', pathEnv)
        : pathApi.join(home, 'library');

  const projectsDir =
    config.projectsDir !== undefined
      ? absoluteOrThrow(config.projectsDir, 'projectsDir', pathEnv)
      : pathApi.join(pathEnv.homedir, 'briefstack-projects');

  return {
    home,
    configFile: pathApi.join(home, CONFIG_FILE),
    userProfilesFile: pathApi.join(home, 'usage-profiles.json'),
    sessionsDir: pathApi.join(home, 'sessions'),
    libraryDir,
    projectsDir,
  };
}

function parseObject(text: string, file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BriefstackError(
      'config.invalidJson',
      { file, detail: error instanceof Error ? error.message : String(error) },
      { cause: error },
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BriefstackError('config.notAnObject', { file });
  }
  return raw as Record<string, unknown>;
}

/** Validates known fields. Unknown fields are ignored here and kept on write. */
export function parseConfig(text: string, file: string): BriefstackConfig {
  const raw = parseObject(text, file);
  const config: BriefstackConfig = {};

  const invalid = (field: string, expected: FieldExpectation): never => {
    throw new BriefstackError('config.invalidField', { file, field, expected });
  };
  const readText = (field: 'activeProfile' | 'libraryDir' | 'projectsDir'): void => {
    const value = raw[field];
    if (value === undefined) return;
    if (typeof value !== 'string' || value.trim() === '') invalid(field, 'text');
    config[field] = value as string;
  };

  readText('activeProfile');
  readText('libraryDir');
  readText('projectsDir');
  if (raw.lang !== undefined) {
    if (!isLang(raw.lang)) invalid('lang', 'lang');
    config.lang = raw.lang as Lang;
  }
  if (raw.permissionPolicy !== undefined) {
    if (!isPermissionPolicy(raw.permissionPolicy)) invalid('permissionPolicy', 'permissionPolicy');
    config.permissionPolicy = raw.permissionPolicy as PermissionPolicy;
  }
  if (raw.maxActiveCreations !== undefined) {
    if (!isPositiveInteger(raw.maxActiveCreations)) invalid('maxActiveCreations', 'positiveInteger');
    config.maxActiveCreations = raw.maxActiveCreations as number;
  }
  for (const field of ['usageWarnFiveHour', 'usageWarnWeek'] as const) {
    if (raw[field] === undefined) continue;
    if (!isPercent(raw[field])) invalid(field, 'percent');
    config[field] = raw[field] as number;
  }
  return config;
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** A missing file is an empty config. */
export async function readConfig(file: string): Promise<BriefstackConfig> {
  const text = await readTextIfExists(file);
  return text === undefined ? {} : parseConfig(text, file);
}

/**
 * Merges `patch` into the file, keeping unknown fields. A field set to
 * `undefined` in the patch is removed. Writes through a temp file + rename.
 */
export async function updateConfig(
  file: string,
  patch: { [K in keyof BriefstackConfig]?: BriefstackConfig[K] | undefined },
): Promise<BriefstackConfig> {
  const text = await readTextIfExists(file);
  const raw = text === undefined ? {} : parseObject(text, file);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  const output = `${JSON.stringify(raw, null, 2)}\n`;
  const config = parseConfig(output, file);

  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, output, 'utf8');
  await rename(temp, file);
  return config;
}

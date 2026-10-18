import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isFullyAbsolute, isPathInside, type PathEnv } from '../config/paths.js';
import { BriefstackError, type SettingsField } from '../errors.js';

/**
 * Adds a folder to `permissions.additionalDirectories` in a Claude Code
 * `settings.local.json`, keeping every other key and entry (decisions §7),
 * and tells whether a folder is already covered by one.
 */

type PathStyle = Pick<PathEnv, 'pathApi' | 'caseInsensitive'>;

/** Absolute, with forward slashes: the form the probe in decisions §7 used. */
export function settingsDirEntry(dir: string, style: Pick<PathEnv, 'pathApi'>): string {
  return style.pathApi.resolve(dir).replace(/\\/g, '/');
}

/** Comparable form: `/` separators, no trailing slash, lower case where paths are case-insensitive. */
export function normaliseDirForCompare(dir: string, style: PathStyle): string {
  let value = dir.trim().replace(/\\/g, '/');
  if (value.length > 1 && !/^[A-Za-z]:\/$/.test(value)) value = value.replace(/\/+$/, '');
  const insensitive = style.caseInsensitive || style.pathApi.sep === '\\';
  return insensitive ? value.toLowerCase() : value;
}

export interface SettingsMerge {
  /** The new file content; unchanged input when nothing was added. */
  text: string;
  added: boolean;
  entry: string;
}

interface ParsedSettings {
  raw: Record<string, unknown>;
  permissions: Record<string, unknown>;
  directories: string[];
}

/**
 * Parses a settings file; `text` is `undefined` when there is none. Throws
 * `init.settingsInvalidJson` / `init.settingsInvalidShape`; `file` only
 * appears in those errors.
 */
function parseSettings(text: string | undefined, file: string): ParsedSettings {
  let raw: unknown = {};
  if (text !== undefined && text.trim() !== '') {
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new BriefstackError('init.settingsInvalidJson', {
        file,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const invalid = (field: SettingsField): never => {
    throw new BriefstackError('init.settingsInvalidShape', { file, field });
  };

  if (!isObject(raw)) return invalid('root');
  const permissions = raw.permissions ?? {};
  if (!isObject(permissions)) return invalid('permissions');
  const current = permissions.additionalDirectories ?? [];
  if (!Array.isArray(current) || current.some((item) => typeof item !== 'string')) {
    return invalid('additionalDirectories');
  }
  return { raw, permissions, directories: current as string[] };
}

/** Pure merge. `text` is the current file or `undefined` when there is none. */
export function mergeAdditionalDirectory(
  text: string | undefined,
  dir: string,
  style: PathStyle,
  file: string,
): SettingsMerge {
  const entry = settingsDirEntry(dir, style);
  const { raw, permissions, directories } = parseSettings(text, file);
  const wanted = normaliseDirForCompare(entry, style);
  if (directories.some((item) => normaliseDirForCompare(item, style) === wanted)) {
    return { text: text ?? '', added: false, entry };
  }
  raw.permissions = { ...permissions, additionalDirectories: [...directories, entry] };
  return { text: `${JSON.stringify(raw, null, 2)}\n`, added: true, entry };
}

export interface AddDirectoryResult {
  file: string;
  entry: string;
  added: boolean;
}

export interface PreparedDirectories {
  file: string;
  /** The file content after every merge. */
  text: string;
  /** One per requested folder, in order. */
  entries: { entry: string; added: boolean }[];
}

const systemStyle = (): PathStyle => ({ pathApi: path, caseInsensitive: process.platform !== 'linux' });

async function readLocalSettings(repoDir: string): Promise<{ file: string; text: string | undefined }> {
  const file = path.join(repoDir, '.claude', 'settings.local.json');
  try {
    return { file, text: await readFile(file, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { file, text: undefined };
  }
}

/** Reads `<repoDir>/.claude/settings.local.json` and merges each folder in turn, writing nothing. */
export async function prepareAdditionalDirectories(
  repoDir: string,
  dirs: readonly string[],
  style: PathStyle = systemStyle(),
): Promise<PreparedDirectories> {
  const { file, text: original } = await readLocalSettings(repoDir);
  let text = original;
  const entries: PreparedDirectories['entries'] = [];
  for (const dir of dirs) {
    const merge = mergeAdditionalDirectory(text, dir, style, file);
    if (merge.added) text = merge.text;
    entries.push({ entry: merge.entry, added: merge.added });
  }
  return { file, text: text ?? '', entries };
}

/** The `additionalDirectories` of `<repoDir>/.claude/settings.local.json`; none when it is missing. */
export async function readAdditionalDirectories(repoDir: string): Promise<string[]> {
  const { file, text } = await readLocalSettings(repoDir);
  return parseSettings(text, file).directories;
}

/**
 * Set by the web runner to the folders it gives its session (a JSON list of
 * absolute paths). Inside that session `paths` reports these, not the repo's
 * `settings.local.json`, which the session does not load.
 */
export const ALLOWED_DIRS_ENV = 'BRIEFSTACK_ALLOWED_DIRS';

/**
 * The folders `ALLOWED_DIRS_ENV` names; undefined when it is not set. A value
 * that is not a list of absolute paths allows nothing.
 */
export function allowedDirsFromEnv(pathEnv: Pick<PathEnv, 'env' | 'pathApi'>): string[] | undefined {
  const raw = pathEnv.env[ALLOWED_DIRS_ENV];
  if (raw === undefined || raw === '') return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const dirs = value.filter((item): item is string => typeof item === 'string');
    return dirs.length === value.length && dirs.every((dir) => isFullyAbsolute(dir, pathEnv.pathApi)) ? dirs : [];
  } catch {
    return [];
  }
}

/** What a session may write to: the runner's folders inside a web session, the settings file otherwise. */
export async function sessionAllowedDirectories(repoDir: string, pathEnv: Pick<PathEnv, 'env' | 'pathApi'>): Promise<string[]> {
  return allowedDirsFromEnv(pathEnv) ?? readAdditionalDirectories(repoDir);
}

/**
 * The entry that already lets Claude Code work in `dir` (the entry itself or
 * a parent of it), or `undefined`. `dir` must be absolute. Entries that are
 * not fully absolute are skipped: what they resolve against is not documented.
 */
export function allowingDirectory(dir: string, entries: readonly string[], style: PathStyle): string | undefined {
  return entries.find((entry) => isFullyAbsolute(entry, style.pathApi) && isPathInside(dir, entry, style));
}

/** Writes prepared merges, once, when any of them adds an entry. */
export async function writePreparedDirectories(prepared: PreparedDirectories): Promise<AddDirectoryResult[]> {
  const { file, text, entries } = prepared;
  if (entries.some((item) => item.added)) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
  }
  return entries.map((item) => ({ file, ...item }));
}

/** Reads, merges and writes the settings file. Invalid JSON leaves the file untouched. */
export async function addAdditionalDirectories(
  repoDir: string,
  dirs: readonly string[],
  style: PathStyle = systemStyle(),
): Promise<AddDirectoryResult[]> {
  return writePreparedDirectories(await prepareAdditionalDirectories(repoDir, dirs, style));
}

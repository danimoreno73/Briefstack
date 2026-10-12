import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PathEnv } from '../config/paths.js';
import { BriefstackError, type SettingsField } from '../errors.js';

/**
 * Adds a folder to `permissions.additionalDirectories` in a Claude Code
 * `settings.local.json`, keeping every other key and entry (decisions §7).
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

/**
 * Pure merge. `text` is the current file or `undefined` when there is none.
 * Throws `init.settingsInvalidJson` / `init.settingsInvalidShape`; `file` only
 * appears in those errors.
 */
export function mergeAdditionalDirectory(
  text: string | undefined,
  dir: string,
  style: PathStyle,
  file: string,
): SettingsMerge {
  const entry = settingsDirEntry(dir, style);
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
  const directories = current as string[];

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

export interface PreparedDirectory {
  file: string;
  merge: SettingsMerge;
}

const systemStyle = (): PathStyle => ({ pathApi: path, caseInsensitive: process.platform !== 'linux' });

/** Reads `<repoDir>/.claude/settings.local.json` and computes the merge, writing nothing. */
export async function prepareAdditionalDirectory(
  repoDir: string,
  dir: string,
  style: PathStyle = systemStyle(),
): Promise<PreparedDirectory> {
  const file = path.join(repoDir, '.claude', 'settings.local.json');
  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { file, merge: mergeAdditionalDirectory(text, dir, style, file) };
}

/** Writes a prepared merge when it adds the entry. */
export async function writePreparedDirectory({ file, merge }: PreparedDirectory): Promise<AddDirectoryResult> {
  if (merge.added) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, merge.text, 'utf8');
    await rename(temp, file);
  }
  return { file, entry: merge.entry, added: merge.added };
}

/** Reads, merges and writes the settings file. Invalid JSON leaves the file untouched. */
export async function addAdditionalDirectory(
  repoDir: string,
  dir: string,
  style: PathStyle = systemStyle(),
): Promise<AddDirectoryResult> {
  return writePreparedDirectory(await prepareAdditionalDirectory(repoDir, dir, style));
}

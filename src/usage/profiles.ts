import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodError } from 'zod';
import type { BriefstackConfig } from '../config/config.js';
import { BriefstackError } from '../errors.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { UsageProfilesFileSchema, type UsagePreset, type UsageProfilesFile } from './schema.js';

/** Used only if neither data file names a default. */
export const FALLBACK_PROFILE = 'balanced';

/** The base presets shipped with briefstack. */
export function baseProfilesFile(packageRoot: string = PACKAGE_ROOT): string {
  return path.join(packageRoot, 'library', 'usage-profiles.json');
}

export type PresetSource = 'base' | 'user';

export interface UsageProfiles {
  /** Profile used when the config has no `activeProfile`. */
  defaultProfile: string;
  presets: Record<string, UsagePreset>;
  sources: Record<string, PresetSource>;
}

/** `path: message` lines; zod messages follow its configured locale. */
export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.map(String).join('.');
    return where === '' ? issue.message : `${where}: ${issue.message}`;
  });
}

/** Parses one profiles file. `file` is for error messages. */
export function parseProfilesFile(text: string, file: string): UsageProfilesFile {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new BriefstackError(
      'usage.invalidProfiles',
      { file, issues: [error instanceof Error ? error.message : String(error)] },
      { cause: error },
    );
  }
  const result = UsageProfilesFileSchema.safeParse(data);
  if (!result.success) {
    throw new BriefstackError('usage.invalidProfiles', { file, issues: formatZodIssues(result.error) });
  }
  return result.data;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface ProfileFiles {
  baseFile: string;
  /** `resolvePaths().userProfilesFile`; a missing file means no user presets. */
  userFile?: string | undefined;
}

/** Base presets merged with the user's by name; the user's win whole. */
export async function loadUsageProfiles(files: ProfileFiles): Promise<UsageProfiles> {
  const baseText = await readIfExists(files.baseFile);
  if (baseText === undefined) {
    throw new BriefstackError('usage.profilesNotFound', { file: files.baseFile });
  }
  const base = parseProfilesFile(baseText, files.baseFile);
  const userText = files.userFile === undefined ? undefined : await readIfExists(files.userFile);
  const user = userText === undefined ? undefined : parseProfilesFile(userText, files.userFile as string);

  const presets: Record<string, UsagePreset> = {};
  const sources: Record<string, PresetSource> = {};
  for (const [name, preset] of Object.entries(base.profiles)) {
    presets[name] = preset;
    sources[name] = 'base';
  }
  for (const [name, preset] of Object.entries(user?.profiles ?? {})) {
    presets[name] = preset;
    sources[name] = 'user';
  }
  const defaultProfile = user?.default ?? base.default ?? FALLBACK_PROFILE;
  return { defaultProfile, presets, sources };
}

/** The preset with that name, or a coded error listing the available ones. */
export function getPreset(profiles: UsageProfiles, name: string): UsagePreset {
  const preset = Object.hasOwn(profiles.presets, name) ? profiles.presets[name] : undefined;
  if (preset === undefined) {
    throw new BriefstackError('usage.unknownProfile', {
      profile: name,
      available: Object.keys(profiles.presets),
    });
  }
  return preset;
}

export interface ActiveProfile {
  name: string;
  preset: UsagePreset;
  /** True when the config sets `activeProfile`; false when the default applies. */
  fromConfig: boolean;
}

/** Config `activeProfile`, else the data files' default. */
export function resolveActiveProfile(config: BriefstackConfig, profiles: UsageProfiles): ActiveProfile {
  const fromConfig = config.activeProfile !== undefined;
  const name = config.activeProfile ?? profiles.defaultProfile;
  return { name, preset: getPreset(profiles, name), fromConfig };
}

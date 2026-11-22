import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import type { Effort } from '../models.js';
import { formatZodIssues, getPreset, loadUsageProfiles, parseProfilesFile, type ProfileFiles } from './profiles.js';
import { FLOW_AGENTS, UsagePresetSchema, UsageProfilesFileSchema, type FlowAgent, type UsagePreset } from './schema.js';

/**
 * A user preset made from another one (IDEAS §3, "Usage: New preset based
 * on Balanced"; phase 9, step 33). It is written to the user's
 * `usage-profiles.json` under the same schema the CLI reads, and nothing
 * else: no agent file. `.claude/agents/*.md` are written only by
 * `briefstack usage set` (and its route, `PUT /api/usage`), when the user
 * chooses the preset afterwards.
 */

export interface NewPresetInput {
  /** The new preset's name (`PROFILE_NAME_RE`); never one that exists, base or user. */
  name: string;
  /** The preset it starts from. */
  base: string;
  label: { en: string; es: string };
  sessionModel?: string | undefined;
  effort?: Effort | undefined;
  /** Model and effort per flow agent; agents left out keep the base's entry. */
  agents?: Partial<Record<FlowAgent, { model: string; effort?: Effort | undefined }>> | undefined;
}

/** The base presets file and the user's (`resolvePaths().userProfilesFile`). */
export interface PresetFiles extends ProfileFiles {
  userFile: string;
}

/** One preset written at a time in this process, so two never lose one another. */
let writing: Promise<unknown> = Promise.resolve();

export function createUserPreset(files: PresetFiles, input: NewPresetInput): Promise<{ name: string; preset: UsagePreset }> {
  const run = writing.then(() => createNow(files, input));
  writing = run.catch(() => undefined);
  return run;
}

async function createNow(files: PresetFiles, input: NewPresetInput): Promise<{ name: string; preset: UsagePreset }> {
  const profiles = await loadUsageProfiles(files);
  if (Object.hasOwn(profiles.presets, input.name)) throw new BriefstackError('usage.presetExists', { name: input.name });
  const base = getPreset(profiles, input.base);
  const agents: Record<string, unknown> = { ...base.agents };
  for (const agent of FLOW_AGENTS) {
    const change = input.agents?.[agent];
    if (change !== undefined) agents[agent] = change.effort === undefined ? change.model : { model: change.model, effort: change.effort };
  }
  const candidate = {
    ...structuredClone(base),
    label: { en: input.label.en, es: input.label.es },
    ...(input.sessionModel === undefined ? {} : { sessionModel: input.sessionModel }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    agents,
  };
  const parsed = UsagePresetSchema.safeParse(candidate);
  if (!parsed.success) throw new BriefstackError('usage.invalidProfiles', { file: path.basename(files.userFile), issues: formatZodIssues(parsed.error) });
  // The user's file as it is: one that does not read back is refused by `parseProfilesFile`, never overwritten.
  let existing: unknown = { profiles: {} };
  try {
    existing = parseProfilesFile(await readFile(files.userFile, 'utf8'), files.userFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = UsageProfilesFileSchema.parse(existing);
  const next = UsageProfilesFileSchema.safeParse({ ...file, profiles: { ...file.profiles, [input.name]: parsed.data } });
  if (!next.success) throw new BriefstackError('usage.invalidProfiles', { file: path.basename(files.userFile), issues: formatZodIssues(next.error) });
  await mkdir(path.dirname(files.userFile), { recursive: true });
  const temp = `${files.userFile}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(next.data, null, 2)}\n`, 'utf8');
  await rename(temp, files.userFile);
  return { name: input.name, preset: parsed.data };
}

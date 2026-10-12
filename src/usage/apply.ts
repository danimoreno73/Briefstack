import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BriefstackError } from '../errors.js';
import { parseFrontmatter, setFrontmatterFields } from '../frontmatter/index.js';
import { TIERS, type Tier } from '../spec/index.js';
import { formatZodIssues, getPreset, type UsageProfiles } from './profiles.js';
import { agentSetting, type AgentSetting, type UsagePreset } from './schema.js';

/** What happened to each agent file, by file name (e.g. `reviewer.md`). */
export interface ApplyResult {
  agentsDir: string;
  /** Files whose `model` or `effort` was rewritten. */
  changed: string[];
  /** Files that already had the right values (left byte-for-byte as they were). */
  unchanged: string[];
  /** Files left alone because the preset (or project profile) does not name their agent. */
  notInProfile: string[];
}

/** `.md` files directly in `dir`, sorted; a missing folder has none. */
async function agentFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/** The agent's name: frontmatter `name`, else the file name without `.md`. */
function agentName(data: Record<string, unknown>, file: string): string {
  return typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : file.slice(0, -'.md'.length);
}

/**
 * Rewrites only `model` and `effort` in each agent file, using `settingFor`.
 * Files are checked before any is written, so a broken file stops the run
 * with nothing changed.
 */
async function applySettings(
  agentsDir: string,
  settingFor: (agent: string) => AgentSetting | undefined,
): Promise<ApplyResult> {
  const result: ApplyResult = { agentsDir, changed: [], unchanged: [], notInProfile: [] };
  const writes: { target: string; text: string }[] = [];

  for (const file of await agentFiles(agentsDir)) {
    const target = path.join(agentsDir, file);
    const text = await readFile(target, 'utf8');
    const setting = settingFor(agentName(parseFrontmatter(text, target).data, file));
    if (setting === undefined) {
      result.notInProfile.push(file);
      continue;
    }
    const updated = setFrontmatterFields(text, { model: setting.model, effort: setting.effort }, target);
    if (updated === text) {
      result.unchanged.push(file);
    } else {
      result.changed.push(file);
      writes.push({ target, text: updated });
    }
  }

  for (const { target, text } of writes) await writeFile(target, text, 'utf8');
  return result;
}

/** Applies a preset to the flow agents in `agentsDir` (the repo's `.claude/agents`). */
export function applyProfileToAgents(agentsDir: string, preset: UsagePreset): Promise<ApplyResult> {
  return applySettings(agentsDir, (agent) => agentSetting(preset, agent));
}

/** `.briefstack/profile.json` in a generated project. */
export const PROJECT_PROFILE_FILE = ['.briefstack', 'profile.json'] as const;

const ProjectProfileSchema = z.looseObject({
  profile: z.string().trim().min(1),
  agents: z.record(z.string(), z.enum(TIERS)),
});

export interface ProjectApplyResult extends ApplyResult {
  projectDir: string;
  profile: string;
  /** Profile recorded in the project before this run. */
  previousProfile: string;
  /** Whether `.briefstack/profile.json` was rewritten. */
  profileFileChanged: boolean;
  /** Agents listed in `profile.json` with no file in `.claude/agents/`. */
  missingAgents: string[];
}

async function readProjectProfile(file: string, projectDir: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new BriefstackError('usage.notABriefstackProject', { dir: projectDir }, { cause: error });
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new BriefstackError(
      'usage.invalidProjectProfile',
      { file, issues: [error instanceof Error ? error.message : String(error)] },
      { cause: error },
    );
  }
  const result = ProjectProfileSchema.safeParse(data);
  if (!result.success) {
    throw new BriefstackError('usage.invalidProjectProfile', { file, issues: formatZodIssues(result.error) });
  }
  return result.data;
}

/**
 * Applies a profile to a project briefstack generated. Each agent's tier in
 * `.briefstack/profile.json` picks the model from the preset's `tiers`; the
 * preset's global effort applies. Refuses folders without that file.
 */
export async function applyProfileToProject(
  projectDir: string,
  profileName: string,
  profiles: UsageProfiles,
): Promise<ProjectApplyResult> {
  const dir = path.resolve(projectDir);
  const profileFile = path.join(dir, ...PROJECT_PROFILE_FILE);
  const raw = await readProjectProfile(profileFile, dir);
  const preset = getPreset(profiles, profileName);

  const tiers = raw.agents as Record<string, Tier>;
  const agentsDir = path.join(dir, '.claude', 'agents');
  const seen = new Set<string>();
  const applied = await applySettings(agentsDir, (agent) => {
    seen.add(agent);
    const tier = Object.hasOwn(tiers, agent) ? tiers[agent] : undefined;
    return tier === undefined ? undefined : { model: preset.tiers[tier], effort: preset.effort };
  });

  const missingAgents = Object.keys(tiers).filter((agent) => !seen.has(agent));

  const previousProfile = raw.profile as string;
  const profileFileChanged = previousProfile !== profileName;
  if (profileFileChanged) {
    const output = `${JSON.stringify({ ...raw, profile: profileName }, null, 2)}\n`;
    const temp = `${profileFile}.${process.pid}.tmp`;
    await writeFile(temp, output, 'utf8');
    await rename(temp, profileFile);
  }

  return { ...applied, projectDir: dir, profile: profileName, previousProfile, profileFileChanged, missingAgents };
}

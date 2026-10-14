import path from 'node:path';
import { configFilePath, readConfig, resolvePaths, updateConfig, type BriefstackConfig, type ResolvedPaths } from '../config/config.js';
import type { PathEnv } from '../config/paths.js';
import { resolveLang, systemLocale, type Lang } from '../i18n/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { applyProfileToAgents, applyProfileToProject, type ApplyResult, type ProjectApplyResult } from './apply.js';
import { checkAgentDrift, type DriftField } from './drift.js';
import { usageEnvWarnings, type EnvWarning } from './env.js';
import { baseProfilesFile, getPreset, loadUsageProfiles, resolveActiveProfile, type UsageProfiles } from './profiles.js';
import { agentSetting, type AgentSetting, type UsagePreset } from './schema.js';

/**
 * `usage show` and `usage set` as library calls, so the CLI and the web
 * server run the same code. The CLI only parses arguments and formats.
 */

export interface UsageContext {
  config: BriefstackConfig;
  paths: ResolvedPaths;
  profiles: UsageProfiles;
}

/** The config, resolved paths and usage presets (base merged with the user's). */
export async function loadUsageContext(pathEnv: PathEnv): Promise<UsageContext> {
  const config = await readConfig(configFilePath(pathEnv));
  const paths = resolvePaths(config, pathEnv);
  const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile(), userFile: paths.userProfilesFile });
  return { config, paths, profiles };
}

/** Folder whose `.claude/agents/` `usage set` rewrites; the briefstack package by default. */
export function repoAgentsDir(repoDir: string = PACKAGE_ROOT): string {
  return path.join(repoDir, '.claude', 'agents');
}

export interface UsageDriftItem {
  file: string;
  field: DriftField;
  committed: string | null;
  current: string | null;
}

/** Exactly what `usage show --json` prints, in that key order. */
export interface UsageShowResult {
  profile: string;
  label: string;
  fromConfig: boolean;
  sessionModel: string;
  agents: Record<string, AgentSetting>;
  tiers: UsagePreset['tiers'];
  research: UsagePreset['research'];
  reviewRounds: number;
  available: string[];
  drift: UsageDriftItem[];
  envWarnings: EnvWarning[];
}

export interface UsageShowOptions {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
  /** Language of `label`; by default the one the CLI would use. */
  lang?: Lang | undefined;
}

/** The active profile, the knobs /new-project follows, and the warnings it relays. */
export async function usageShow(options: UsageShowOptions): Promise<UsageShowResult> {
  const { pathEnv } = options;
  const { config, profiles } = await loadUsageContext(pathEnv);
  const lang = options.lang ?? resolveLang({ env: pathEnv.env, configLang: config.lang, osLocale: systemLocale() });
  const active = resolveActiveProfile(config, profiles);
  const { preset } = active;
  const drift = await checkAgentDrift(repoAgentsDir(options.repoDir));
  const agents = Object.fromEntries(
    Object.keys(preset.agents).flatMap((agent) => {
      const setting = agentSetting(preset, agent);
      return setting === undefined ? [] : [[agent, setting]];
    }),
  ) as Record<string, AgentSetting>;
  return {
    profile: active.name,
    label: preset.label[lang],
    fromConfig: active.fromConfig,
    sessionModel: preset.sessionModel,
    agents,
    tiers: preset.tiers,
    research: preset.research,
    reviewRounds: preset.reviewRounds,
    available: Object.keys(profiles.presets),
    drift:
      drift.status === 'checked'
        ? drift.drift.map((item) => ({ ...item, committed: item.committed ?? null, current: item.current ?? null }))
        : [],
    envWarnings: usageEnvWarnings(pathEnv.env),
  };
}

export interface UsageSetOptions {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
  profile: string;
  /** An absolute path: apply to that generated project instead of the repo's agents. */
  project?: string | undefined;
}

export type UsageSetResult =
  | {
      scope: 'repo';
      profile: string;
      sessionModel: string;
      /** The repo's agent files. */
      result: ApplyResult;
      /** Where `activeProfile` was saved. */
      configFile: string;
    }
  | {
      scope: 'project';
      profile: string;
      sessionModel: string;
      result: ProjectApplyResult;
    };

/**
 * Applies a profile: to the repo's agent files and the config's
 * `activeProfile`, or, with `project`, to a project briefstack generated.
 * An unknown profile is refused before anything is written.
 */
export async function usageSet(options: UsageSetOptions): Promise<UsageSetResult> {
  const { paths, profiles } = await loadUsageContext(options.pathEnv);
  const preset = getPreset(profiles, options.profile);
  const base = { profile: options.profile, sessionModel: preset.sessionModel };

  if (options.project !== undefined) {
    const result = await applyProfileToProject(options.project, options.profile, profiles);
    return { scope: 'project', ...base, result };
  }

  const result = await applyProfileToAgents(repoAgentsDir(options.repoDir), preset);
  await updateConfig(paths.configFile, { activeProfile: options.profile });
  return { scope: 'repo', ...base, result, configFile: paths.configFile };
}

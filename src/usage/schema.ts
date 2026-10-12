import { z } from 'zod';
import { LANGS } from '../i18n/index.js';
import { EFFORT_LEVELS, isValidModel, type Effort } from '../models.js';
import { TIERS } from '../spec/index.js';

/** The five agents of the creation flow, in flow order. */
export const FLOW_AGENTS = ['interviewer', 'researcher', 'architect', 'generator', 'reviewer'] as const;
export type FlowAgent = (typeof FLOW_AGENTS)[number];

export const RESEARCH_MODES = ['required-only', 'when-useful'] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

/** Profile names are written to config and CLI arguments: keep them simple. */
export const PROFILE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Session model: anything `/model` accepts (e.g. `opusplan`, `best`), as a
 * single token. It is only shown to the user, never written to a file.
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;
export const ModelSchema = z.string().regex(MODEL_RE);

/** Agent and tier models end up in agent frontmatter: same rule as `validate`. */
export const AgentModelSchema = z.string().refine(isValidModel);

const AgentEntrySchema = z.union([
  AgentModelSchema,
  z.strictObject({ model: AgentModelSchema, effort: z.enum(EFFORT_LEVELS).optional() }),
]);

const labelShape = Object.fromEntries(LANGS.map((lang) => [lang, z.string().trim().min(1)])) as Record<
  (typeof LANGS)[number],
  z.ZodString
>;

const agentsShape = Object.fromEntries(FLOW_AGENTS.map((name) => [name, AgentEntrySchema])) as Record<
  FlowAgent,
  typeof AgentEntrySchema
>;

const tiersShape = Object.fromEntries(TIERS.map((tier) => [tier, AgentModelSchema])) as Record<
  (typeof TIERS)[number],
  typeof AgentModelSchema
>;

/**
 * One preset. `agents` must cover the five flow agents and may name more;
 * each entry is a model or `{ model, effort }` to override the global effort.
 */
export const UsagePresetSchema = z.strictObject({
  label: z.strictObject(labelShape),
  sessionModel: ModelSchema,
  effort: z.enum(EFFORT_LEVELS),
  agents: z.object(agentsShape).catchall(AgentEntrySchema),
  tiers: z.strictObject(tiersShape),
  research: z.enum(RESEARCH_MODES),
  reviewRounds: z.int().min(1).max(10),
});

export const UsageProfilesFileSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Profile used when the config has no `activeProfile`. */
  default: z.string().regex(PROFILE_NAME_RE).optional(),
  profiles: z.record(z.string().regex(PROFILE_NAME_RE), UsagePresetSchema),
});

export type UsagePresetInput = z.input<typeof UsagePresetSchema>;
export type UsagePreset = z.output<typeof UsagePresetSchema>;
export type UsageProfilesFile = z.output<typeof UsageProfilesFileSchema>;

/** What an agent file should say for `model` and `effort`. */
export interface AgentSetting {
  model: string;
  effort: Effort;
}

/** The setting for a flow (or extra) agent named in the preset, if any. */
export function agentSetting(preset: UsagePreset, agent: string): AgentSetting | undefined {
  if (!Object.hasOwn(preset.agents, agent)) return undefined;
  const entry = preset.agents[agent];
  if (entry === undefined) return undefined;
  return typeof entry === 'string'
    ? { model: entry, effort: preset.effort }
    : { model: entry.model, effort: entry.effort ?? preset.effort };
}

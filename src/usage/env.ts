/**
 * Environment variables that defeat the agent frontmatter (`decisions.md` §3).
 * `CLAUDE_CODE_SUBAGENT_MODEL` ranks below frontmatter, so it is not listed.
 */
export const OVERRIDING_ENV_VARS = {
  /** Claude Code ignores frontmatter `model` while this is set. */
  model: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  /** Beats frontmatter `effort`. */
  effort: 'CLAUDE_CODE_EFFORT_LEVEL',
} as const;

export interface EnvWarning {
  field: keyof typeof OVERRIDING_ENV_VARS;
  variable: string;
  value: string;
}

export function usageEnvWarnings(env: Readonly<Record<string, string | undefined>>): EnvWarning[] {
  const warnings: EnvWarning[] = [];
  for (const [field, variable] of Object.entries(OVERRIDING_ENV_VARS) as [EnvWarning['field'], string][]) {
    const value = env[variable]?.trim();
    if (value !== undefined && value !== '') warnings.push({ field, variable, value });
  }
  return warnings;
}

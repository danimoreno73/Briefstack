/**
 * Values a subagent's `model` and `effort` frontmatter may take
 * (`decisions.md` §2). Shared by usage presets and the validator so a
 * preset can never write a value `validate` would reject.
 */

export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const ALIAS_RE = new RegExp(`^(?:${MODEL_ALIASES.join('|')})(?:\\[1m\\])?$`);
const FULL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]*(?:\[1m\])?$/;

/** `sonnet`, `opus[1m]`, a full `claude-...` ID, or `inherit`. */
export function isValidModel(value: string): boolean {
  return value === 'inherit' || ALIAS_RE.test(value) || FULL_ID_RE.test(value);
}

export function isValidEffort(value: string): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

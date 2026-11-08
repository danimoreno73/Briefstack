/**
 * The environment Codex gets (decisions.md, "Phase 8: Codex spike"): no
 * credential of ours, no Claude Code, briefstack or GitHub variable, and no
 * `CODEX_HOME`, so Codex uses its own login in the user's profile.
 */

const SECRET_PART = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;
const OURS = /^(ANTHROPIC_|CLAUDE|BRIEFSTACK_|GH_|GITHUB_)/i;
const CODEX_HOME = /^CODEX_HOME$/i;

/** Whether a variable never reaches Codex. */
export const isDroppedForCodex = (name: string): boolean => SECRET_PART.test(name) || OURS.test(name) || CODEX_HOME.test(name);

/** The environment without the dropped variables, and their names (sorted), never their values. */
export function codexEnvironment(env: Readonly<Record<string, string | undefined>>): { env: Record<string, string>; removed: string[] } {
  const kept: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isDroppedForCodex(name)) removed.push(name);
    else kept[name] = value;
  }
  return { env: kept, removed: removed.sort() };
}

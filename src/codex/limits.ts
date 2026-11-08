/**
 * Codex settings and limits (decisions.md, "Phase 8: step 25"). A pure
 * module: the config, the server and the browser import it.
 */

/** The Windows sandbox modes Codex offers. `unelevated` runs as the user; `elevated` as a sandbox account. */
export const CODEX_SANDBOX_MODES = ['unelevated', 'elevated'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** On the user's machine `unelevated` is the only mode that runs Node installed in the profile (nvm); neither closes the network. */
export const DEFAULT_CODEX_MODE: CodexSandboxMode = 'unelevated';

export const DEFAULT_CODEX_MAX_CALLS = 5;
export const MIN_CODEX_MAX_CALLS = 1;
export const MAX_CODEX_MAX_CALLS = 10;

/** The longest instruction Claude can hand to Codex in one call. */
export const MAX_CODEX_INSTRUCTION = 20_000;

/** How long one `codex exec` call may take before its process tree is ended. */
export const CODEX_CALL_TIMEOUT_MS = 10 * 60_000;

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === 'string' && (CODEX_SANDBOX_MODES as readonly string[]).includes(value);
}

export function isCodexMaxCalls(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_CODEX_MAX_CALLS && value <= MAX_CODEX_MAX_CALLS;
}

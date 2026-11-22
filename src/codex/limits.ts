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

/**
 * Codex without its shell (decisions.md, "Phase 10: H0", 1): the measured
 * set of calls 3–8. Not only the shell: the user's `config.toml` may bring
 * MCP servers (a Node REPL among them), plugins and apps add tools, hooks
 * run commands, and the web tool reaches the Internet from OpenAI's side.
 * Only creations use it; tasks keep Codex with its shell.
 */
export const CODEX_NO_SHELL_FEATURES = ['shell_tool', 'multi_agent', 'plugins', 'apps', 'hooks', 'browser_use', 'computer_use'] as const;

/** The no-shell arguments `codex exec` takes (`--ignore-user-config` is an `exec` option). */
export const CODEX_NO_SHELL_EXEC_ARGS: readonly string[] = ['--ignore-user-config', ...CODEX_NO_SHELL_FEATURES.flatMap((feature) => ['--disable', feature]), '-c', 'web_search="disabled"'];

/** The same features for `codex debug prompt-input`, which has no `--ignore-user-config`. */
export const CODEX_NO_SHELL_FEATURE_ARGS: readonly string[] = [...CODEX_NO_SHELL_FEATURES.flatMap((feature) => ['--disable', feature]), '-c', 'web_search="disabled"'];

/** Tool names that run commands; the no-shell check fails when the rendered input still names one. */
export const CODEX_SHELL_TOOL_NAMES = ['exec_command', 'write_stdin', 'shell', 'local_shell', 'unified_exec'] as const;

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === 'string' && (CODEX_SANDBOX_MODES as readonly string[]).includes(value);
}

export function isCodexMaxCalls(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_CODEX_MAX_CALLS && value <= MAX_CODEX_MAX_CALLS;
}

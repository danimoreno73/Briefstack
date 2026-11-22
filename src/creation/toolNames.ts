/** Names of the in-process `briefstack-web` tools, apart so the guard and the server share them without a cycle. */
export const WEB_SERVER_NAME = 'briefstack-web';
export const APPROVE_SPEC_TOOL = `mcp__${WEB_SERVER_NAME}__approve_spec`;
export const GRANT_DIRECTORY_TOOL = `mcp__${WEB_SERVER_NAME}__grant_directory`;

/** The implement step's tools (phase 10, PLAN-phase-10 §1, 4): the main session's two. */
export const IMPLEMENT_START_TOOL = `mcp__${WEB_SERVER_NAME}__implement_start`;
export const IMPLEMENT_FINISH_TOOL = `mcp__${WEB_SERVER_NAME}__implement_finish`;
/** The implementer's: the listed commands, and Codex without its shell when the user ticked it. */
export const RUN_COMMAND_TOOL = `mcp__${WEB_SERVER_NAME}__run_command`;
export const CREATION_CODEX_TOOL = `mcp__${WEB_SERVER_NAME}__delegate_to_codex`;

/** The agent type of the implement step. */
export const IMPLEMENTER_AGENT = 'implementer';

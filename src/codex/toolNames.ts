/**
 * The task session's own MCP server and its one tool (decisions.md, "Phase
 * 8: step 25"). A pure module, so the guard can name the tool without
 * loading the SDK.
 */

export const TASK_TOOLS_SERVER_NAME = 'briefstack-task';
export const DELEGATE_TO_CODEX = 'delegate_to_codex';

/** The name Claude Code gives the tool: `mcp__<server>__<tool>`. */
export const CODEX_TOOL_ID = `mcp__${TASK_TOOLS_SERVER_NAME}__${DELEGATE_TO_CODEX}`;

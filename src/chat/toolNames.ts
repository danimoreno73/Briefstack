/**
 * The global chat's MCP server and its tools (BRIEF-phase-4 §3.1). The list
 * is closed: the chat session gets exactly these, and nothing else. A pure
 * module, so the SDK warning filter can name them without loading the tools.
 */

export const CHAT_SERVER_NAME = 'briefstack-chat';

export const CHAT_READ_TOOLS = [
  'list_projects',
  'show_project',
  'search_library',
  'read_note',
  'list_sessions',
  'session_panel',
  'show_usage',
  'show_settings',
] as const;

export const CHAT_ACTION_TOOLS = ['start_creation', 'cancel_creation', 'propose_note_change', 'set_usage_profile'] as const;

export type ChatToolName = (typeof CHAT_READ_TOOLS)[number] | (typeof CHAT_ACTION_TOOLS)[number];

export const CHAT_TOOL_NAMES: readonly ChatToolName[] = [...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS];

/** The name Claude Code gives an MCP tool: `mcp__<server>__<tool>`. */
export const chatToolId = (name: string): string => `mcp__${CHAT_SERVER_NAME}__${name}`;

/** Every chat tool by its Claude Code name: the chat session's whole tool list. */
export const CHAT_TOOL_IDS: readonly string[] = CHAT_TOOL_NAMES.map(chatToolId);

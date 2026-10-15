/** Names of the two in-process `briefstack-web` tools, apart so the guard and the server share them without a cycle. */
export const WEB_SERVER_NAME = 'briefstack-web';
export const APPROVE_SPEC_TOOL = `mcp__${WEB_SERVER_NAME}__approve_spec`;
export const GRANT_DIRECTORY_TOOL = `mcp__${WEB_SERVER_NAME}__grant_directory`;

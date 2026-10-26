/**
 * Claude Code's built-in tools, for the `tools` of a generated agent
 * (backlog 2). A name not in this list is refused by `spec check`, so a typo
 * or a retired tool is caught before the project is written, not when
 * Claude Code refuses the agent ("would be spawned with zero tools").
 *
 * Source: the tools reference, https://code.claude.com/docs/en/tools-reference,
 * read on 2026-10-26 (Claude Code 2.1.310); docs/decisions.md, "Backlog 2:
 * agent tools checked against Claude Code's list". Keep it current with
 * that page: a tool Claude Code adds is refused here until it is listed.
 */
export const CLAUDE_CODE_TOOLS = [
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
] as const;

/**
 * Tools Claude Code no longer has, with the tool that does the job now.
 * `TaskOutput`: "Removed in v2.1.277 … Claude reads a background task's
 * output file with `Read` instead" (tools reference). `MultiEdit`: gone from
 * the tools reference and from the SDK's tool input types (0.3.286); `Edit`
 * makes its edits.
 */
export const RETIRED_TOOLS: Readonly<Record<string, string>> = {
  MultiEdit: 'Edit',
  TaskOutput: 'Read',
};

const KNOWN: ReadonlySet<string> = new Set(CLAUDE_CODE_TOOLS);

/** The tool a rule names: `Bash` for `Bash(npm test:*)`. */
export const toolBaseName = (value: string): string => value.replace(/\(.*$/s, '');

export type ToolNameVerdict = { rule: 'retiredTool'; tool: string; replacement: string } | { rule: 'unknownTool'; tool: string };

/**
 * Whether an agent's tool entry names a tool Claude Code has. MCP tools
 * (`mcp__…`) are the project's own and are not checked here. `undefined`
 * means the name is known.
 */
export function checkToolName(value: string): ToolNameVerdict | undefined {
  if (value.startsWith('mcp__')) return undefined;
  const tool = toolBaseName(value);
  if (KNOWN.has(tool)) return undefined;
  const replacement = RETIRED_TOOLS[tool];
  return replacement === undefined ? { rule: 'unknownTool', tool } : { rule: 'retiredTool', tool, replacement };
}

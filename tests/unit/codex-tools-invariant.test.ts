import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS, CHAT_SERVER_NAME, CHAT_TOOL_IDS } from '../../src/chat/toolNames.js';
import { buildChatOptions } from '../../src/chat/sdkChatRunner.js';
import { CODEX_TOOL_ID, TASK_TOOLS_SERVER_NAME } from '../../src/codex/toolNames.js';
import { evaluateToolUse, FLOW_BUILTIN_TOOLS, FLOW_TOOLS } from '../../src/creation/guard.js';
import { SHADOWED_TOOL_SETS } from '../../src/creation/sdkWarnings.js';
import { SKILL_TOOL, TASK_BUILTIN_TOOLS } from '../../src/tasks/guard.js';
import { taskTools } from '../../src/tasks/session.js';

// delegate_to_codex exists only in task sessions (decisions.md, "Phase 8:
// step 25"): the chat keeps exactly its 22 tools, a creation its own, and a
// task's built-in tools and skills layers do not change.

describe('no other session gains a tool', () => {
  it('the chat has exactly its 22 tools, by name', () => {
    expect([...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS]).toEqual([
      'list_projects',
      'show_project',
      'search_library',
      'read_note',
      'list_sessions',
      'session_panel',
      'show_usage',
      'show_settings',
      'list_suggestions',
      'list_proposals',
      'show_proposal',
      'list_skills',
      'list_tasks',
      'show_task',
      'start_creation',
      'cancel_creation',
      'start_task',
      'propose_note_change',
      'set_usage_profile',
      'prepare_improvement',
      'add_skill',
      'add_skill_to_project',
    ]);
    expect(CHAT_TOOL_IDS).toHaveLength(22);
    expect(CHAT_TOOL_IDS.every((id) => id.startsWith(`mcp__${CHAT_SERVER_NAME}__`))).toBe(true);
    expect(CHAT_TOOL_IDS).not.toContain(CODEX_TOOL_ID);
  });

  it('the chat session gets only its own server, no built-in tool, and only its 22 tools allowed', () => {
    const options = buildChatOptions({
      home: os.tmpdir(),
      executable: 'claude',
      env: {},
      model: 'sonnet',
      effort: 'low',
      mcpServer: { type: 'sdk', name: CHAT_SERVER_NAME } as never,
      abortController: new AbortController(),
      spawn: (() => undefined) as never,
    });
    expect(Object.keys(options.mcpServers ?? {})).toEqual([CHAT_SERVER_NAME]);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([...CHAT_TOOL_IDS]);
  });

  it('a creation\'s tools do not include it, and its guard refuses it', async () => {
    expect(FLOW_BUILTIN_TOOLS as readonly string[]).not.toContain(CODEX_TOOL_ID);
    expect(FLOW_TOOLS.has(CODEX_TOOL_ID)).toBe(false);
    for (const set of SHADOWED_TOOL_SETS) expect(set).not.toContain(CODEX_TOOL_ID);
    const cwd = path.resolve('creation');
    const verdict = await evaluateToolUse(
      { isOwnSession: () => true, sessionDir: () => cwd, projectsDir: cwd, libraryDir: path.resolve('library'), cwd, grantedDirs: () => [], cancelled: () => false },
      { session_id: 's1', tool_name: CODEX_TOOL_ID, tool_input: { instruction: 'Go.' } },
    );
    expect(verdict.verdict).toBe('deny');
  });

  it('a task keeps its built-in tools and its skills layer; the tool comes only from its own MCP server', () => {
    expect(taskTools([])).toEqual([...TASK_BUILTIN_TOOLS]);
    expect(taskTools(['deploy'])).toEqual([...TASK_BUILTIN_TOOLS, SKILL_TOOL]);
    expect(taskTools(['deploy'])).not.toContain(CODEX_TOOL_ID);
    expect(CODEX_TOOL_ID).toBe(`mcp__${TASK_TOOLS_SERVER_NAME}__delegate_to_codex`);
  });
});

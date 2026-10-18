// Real check 4 (PLAN-phase-2, "Real runs"; added after the failed H10 run of
// 2026-10-16): a subagent's report reaches the main session of a creation.
//
// Starts one short haiku session in a temp folder with the options SdkRunner
// uses (guard hook, tool list, `auto` mode and the runner's environment, which
// turns background tasks off) plus one throwaway haiku agent, `echo`, whose
// whole report is one random word. The main session is not told how to run
// it. Expected:
//   1. the Agent call runs in the foreground (its result is not "Async agent
//      launched") and the word reaches the main session. The word need not be
//      in the Agent result: in auto mode that only says the report was
//      delivered through SubagentHandback;
//   2. the main session's final answer has the word;
//   3. the guard denies nothing, so SubagentHandback goes through;
//   4. the main session runs no shell command (no `sleep` while it waits).
// Spends a few short turns of haiku. Run:  npx tsx scripts/real/check-subagent.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { guardHook, type GuardContext } from '../../src/creation/guard.js';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

requireConfirmation('Check that a subagent report reaches the main session (haiku, one subagent, one word).');

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('subagent');
  check.add(() => box.cleanup());
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  const word = `heron${randomInt(1000, 10000)}`;
  let claimed: string | undefined;
  const denials: string[] = [];
  const calls: string[] = [];
  const agentResults: string[] = [];
  const agentUseIds = new Set<string>();
  let finalText = '';
  const context: GuardContext = {
    isOwnSession: (id) => {
      claimed ??= id;
      return claimed === id;
    },
    sessionDir: (id) => path.join(box.sessions, id),
    projectsDir: box.projects,
    grantedDirs: () => [],
    cancelled: () => false,
  };
  const tracked = spawnTracked();

  const options = buildQueryOptions({
    repoDir: box.project,
    executable,
    profile: { name: 'check', sessionModel: 'haiku', effort: 'low' },
    env: sessionEnv(box),
    additionalDirectories: [box.projects],
    hooks: {
      PreToolUse: [
        {
          hooks: [
            guardHook(context, (denial) => denials.push(`${denial.agentType ?? 'main'} ${denial.toolName}: ${denial.summary}`)),
            async (input) => {
              if (input.hook_event_name === 'PreToolUse') calls.push(`${input.agent_type ?? 'main'}:${input.tool_name}`);
              return {};
            },
          ],
        },
      ],
    },
    canUseTool: async () => ({ behavior: 'deny', message: 'Not allowed in this check.' }),
    mcpServers: {},
    abortController: new AbortController(),
    spawn: (spawnOptions) => tracked.spawn(spawnOptions),
  });
  // The check is not the briefstack repo: no skill, no project settings.
  options.settingSources = [];
  options.maxTurns = 6;
  options.agents = {
    echo: {
      description: 'Reports one word. Use it when asked to run the echo agent.',
      prompt: `Your whole report is the single word ${word}. Use no tool to find it; report it and stop.`,
      model: 'haiku',
      tools: ['Read'],
    },
  };

  const prompt =
    'Use the Agent tool with subagent_type "echo" and the prompt "Report your word." ' +
    'When you have its report, reply with exactly the word it reported and nothing else.';
  const q = check.query(query({ prompt: oneShot(prompt), options }), tracked);
  for await (const message of q) {
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && block.name === 'Agent') agentUseIds.add(block.id);
      }
    }
    if (message.type === 'user' && message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === 'object' && block.type === 'tool_result' && agentUseIds.has(block.tool_use_id)) {
          agentResults.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        }
      }
    }
    if (message.type === 'result') {
      finalText = 'result' in message && typeof message.result === 'string' ? message.result : '';
      break;
    }
  }
  q.close();
  await tracked.killTree();

  console.log(`\nWord: ${word}`);
  console.log('Tool calls:', calls);
  console.log('Denied by the guard:', denials);
  console.log('Agent results:', agentResults.map((text) => text.slice(0, 200)));
  // In auto mode the Agent result only says the report was delivered through
  // SubagentHandback; the report itself reaches the main session apart from it.
  const first = agentResults[0] ?? '';
  ok =
    report(
      'the Agent call ran in the foreground and the word reached the main session',
      agentResults.length > 0 && !/Async agent launched/i.test(first) && finalText.includes(word),
      agentResults.length === 0 ? 'no Agent call' : first.slice(0, 120),
    ) && ok;
  ok = report('the main session answered with the word', finalText.includes(word), finalText.slice(0, 120) || 'no final text') && ok;
  ok = report('the guard denied nothing', denials.length === 0, denials.join(' | ') || 'no denials') && ok;
  ok =
    report(
      'the main session ran no shell command',
      !calls.some((call) => call === 'main:Bash' || call === 'main:PowerShell'),
      calls.filter((call) => call.startsWith('main:')).join(', '),
    ) && ok;
  console.log(
    `Info: the subagent ${calls.includes('echo:SubagentHandback') ? 'reported through SubagentHandback' : 'did not call SubagentHandback (plain-text report)'}.`,
  );

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

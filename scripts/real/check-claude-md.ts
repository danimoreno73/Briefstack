// Real check (backlog 2, B8): a creation's sessions do not load the repo's
// CLAUDE.md.
//
// One short haiku session with the options SdkRunner uses (`buildQueryOptions`:
// project settings only, `auto` mode, the runner's environment, and the flag
// settings with `claudeMdExcludes`), in a temp folder that stands in for the
// repo. Three memory files, each with its own random marker word:
//   - <repo>/CLAUDE.md: the file creations must not load (excluded);
//   - <repo>/.claude/rules/control.md: a control, never excluded, which
//     project settings load at start, to show the model reports what it got;
//   - <repo>/../CLAUDE.md: a folder above the repo, which the docs say loads
//     too (reported, not excluded).
// A file-based agent, `probe` (<repo>/.claude/agents/probe.md, as the flow's
// agents are), reports the markers in its context; the main session reports
// its own. Neither can read files: the words can only come from the memory
// Claude Code loaded. Everything the main session and the subagent wrote is
// printed and searched, not only the final reply.
//
// Expected, normal run:
//   1. main and subagent see the control word (memory loads, the model reports it);
//   2. neither sees the repo's CLAUDE.md word;
//   3. only planted words are reported.
// With --no-exclude (a control run: the same session without
// `claudeMdExcludes`), 2 is reversed: both must see the repo's CLAUDE.md
// word, which shows that the marker would be seen if it loaded.
// Either way, for information: whether the word from the folder above was seen.
// A few short haiku turns.
// Run:  npx tsx scripts/real/check-claude-md.ts --yes [--no-exclude]

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

const noExclude = process.argv.includes('--no-exclude');
requireConfirmation(
  `Check that creation sessions do not load the repo’s CLAUDE.md (haiku, one subagent)${noExclude ? ', control run without claudeMdExcludes' : ''}.`,
);

const word = (stem: string) => `${stem}${randomInt(1000, 10000)}`;
/** Marker-like words ("otter1234") anywhere in a text. */
const markers = (text: string): string[] => [...new Set([...text.matchAll(/\b[a-z]+\d{4}\b/g)].map((match) => match[0]))];
/** The text blocks of an assistant message. */
const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((block: { type?: string; text?: string }) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n') : '';

// Where the memory arrives: Claude Code puts CLAUDE.md files and rules in the conversation as context
// (reminders headed with the file's path), not in the system prompt, so the request names that place.
const LOOK =
  'Look through everything in your context before this request: the system prompt and, above all, the project ' +
  'instructions and rules Claude Code loaded from CLAUDE.md and .claude/rules files (shown to you as system reminders ' +
  'or "Contents of …" blocks).';

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('claude-md');
  check.add(() => box.cleanup());
  console.log(`Mode: ${noExclude ? 'CONTROL, no claudeMdExcludes' : 'normal, with claudeMdExcludes'}`);
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  const excluded = word('heron');
  const control = word('otter');
  const above = word('lynx');
  const line = (marker: string) => `# Notes\n\nThe marker word of this file is ${marker}.\n`;
  await writeFile(path.join(box.project, 'CLAUDE.md'), line(excluded), 'utf8');
  await mkdir(path.join(box.project, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(box.project, '.claude', 'rules'), { recursive: true });
  await writeFile(path.join(box.project, '.claude', 'rules', 'control.md'), line(control), 'utf8');
  await writeFile(path.join(box.dir, 'CLAUDE.md'), line(above), 'utf8');
  await writeFile(
    path.join(box.project, '.claude', 'agents', 'probe.md'),
    [
      '---',
      'name: probe',
      'description: Reports the marker words in its context. Use it when asked to run the probe agent.',
      'tools: Glob',
      'model: haiku',
      '---',
      '',
      `Use no tool. ${LOOK}`,
      'Find every sentence "The marker word of this file is <word>." in them.',
      'Reply with one line: "MARKERS: " and each such word, or "MARKERS: none". Never guess a word.',
      '',
    ].join('\n'),
    'utf8',
  );

  const tracked = spawnTracked();
  const calls: string[] = [];
  const options = buildQueryOptions({
    repoDir: box.project,
    executable,
    profile: { name: 'check', sessionModel: 'haiku', effort: 'low' },
    env: sessionEnv(box),
    additionalDirectories: [],
    hooks: {
      PreToolUse: [
        {
          hooks: [
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
  // The control run: the same flag settings without the exclusion.
  if (noExclude) options.settings = {};
  console.log(`Flag settings: ${JSON.stringify(options.settings)}`);
  // No file reads: the markers must come from the memory Claude Code loaded, not from the files.
  options.tools = ['Agent'];
  options.maxTurns = 6;

  const prompt = [
    `Use no tool except Agent. ${LOOK}`,
    'Find every sentence "The marker word of this file is <word>." in them. Never guess a word.',
    'Then use the Agent tool with subagent_type "probe" and the prompt "Report your markers."',
    'Your final reply has exactly two lines:',
    '"MAIN: " and the words you found yourself (or "none"),',
    '"PROBE: " and the words of the probe\'s MARKERS line (or "none").',
  ].join('\n');
  const mainTexts: string[] = [];
  const agentTexts: string[] = [];
  const agentResults: string[] = [];
  const agentUseIds = new Set<string>();
  let finalText = '';
  const q = check.query(query({ prompt: oneShot(prompt), options }), tracked);
  for await (const message of q) {
    if (message.type === 'assistant') {
      const text = textOf(message.message.content);
      // A subagent's own messages carry the id of the Agent call that started it.
      if (message.parent_tool_use_id === null) {
        if (text !== '') mainTexts.push(text);
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && block.name === 'Agent') agentUseIds.add(block.id);
        }
      } else if (text !== '') agentTexts.push(text);
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

  console.log(`\nWords: repo CLAUDE.md ${excluded}, control (rules) ${control}, folder above ${above}`);
  console.log('Tool calls:', calls);
  console.log(`Main session wrote:\n${mainTexts.join('\n---\n') || '(nothing)'}`);
  console.log(`Subagent wrote:\n${agentTexts.join('\n---\n') || '(nothing streamed)'}`);
  console.log(`Agent results:\n${agentResults.join('\n---\n') || '(none)'}`);
  console.log(`Final reply:\n${finalText}`);

  // The main session's words: everything it wrote except its PROBE line, which repeats the subagent.
  const mainOwn = markers([...mainTexts, finalText].join('\n').split(/\r?\n/).filter((item) => !/^\W*PROBE\b/i.test(item.trim())).join('\n'));
  // The subagent's words: what it wrote itself when the stream carries it; else what reached the main
  // session from it (the Agent result, which in auto mode may only say the report was handed back, and
  // the main session's PROBE line).
  const probeLine = markers([...mainTexts, finalText].join('\n').split(/\r?\n/).filter((item) => /^\W*PROBE\b/i.test(item.trim())).join('\n'));
  const probe = agentTexts.length > 0 ? markers(agentTexts.join('\n')) : markers([...agentResults, probeLine.join(' ')].join('\n'));
  const planted = new Set([excluded, control, above]);
  const list = (words: string[]) => words.join(', ') || 'none';
  ok = report('the probe agent ran', calls.includes('main:Agent'), calls.join(', ') || 'no tool calls') && ok;
  ok = report('main: the control word is there (memory loads and is reported)', mainOwn.includes(control), list(mainOwn)) && ok;
  ok = report('subagent: the control word is there', probe.includes(control), list(probe)) && ok;
  if (noExclude) {
    ok = report('control run, main: the repo’s CLAUDE.md word is there', mainOwn.includes(excluded), list(mainOwn)) && ok;
    ok = report('control run, subagent: the repo’s CLAUDE.md word is there', probe.includes(excluded), list(probe)) && ok;
  } else {
    ok = report('main: the repo’s CLAUDE.md is not', !mainOwn.includes(excluded), list(mainOwn)) && ok;
    ok = report('subagent: the repo’s CLAUDE.md is not', !probe.includes(excluded), list(probe)) && ok;
  }
  ok = report('only planted words were reported', [...mainOwn, ...probe].every((item) => planted.has(item)), list([...mainOwn, ...probe])) && ok;
  console.log(`Info: the subagent's words come from ${agentTexts.length > 0 ? 'its own messages' : 'the Agent result and the PROBE line'}; the PROBE line said ${list(probeLine)}.`);
  console.log(`Info: the CLAUDE.md above the repo was ${mainOwn.includes(above) ? '' : 'NOT '}seen by the main session and ${probe.includes(above) ? '' : 'NOT '}by the subagent.`);

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

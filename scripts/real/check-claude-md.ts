// Real check (backlog 2, B8): a creation's sessions do not load the repo's
// CLAUDE.md.
//
// One short haiku session with the options SdkRunner uses (`buildQueryOptions`:
// project settings only, `auto` mode, the runner's environment, and the flag
// settings with `claudeMdExcludes`), in a temp folder that stands in for the
// repo. Three memory files there, each with its own random marker word:
//   - <repo>/CLAUDE.md: the file creations must not load (excluded);
//   - <repo>/.claude/CLAUDE.md: a control, not excluded, to show that project
//     memory loads at all;
//   - <repo>/../CLAUDE.md: a folder above the repo, which the docs say loads
//     too (reported, not excluded).
// A file-based agent, `probe` (<repo>/.claude/agents/probe.md, as the flow's
// agents are), reports the markers it sees in its own instructions; the main
// session reports its own and the probe's. Neither may read files. Expected:
//   1. the main session sees the control word and not the excluded one;
//   2. the subagent sees the control word and not the excluded one;
//   3. the words they report are only the three planted ones (no guessing);
//   and, for information, whether the word from the folder above was seen.
// The guard's own flag settings are checked by the unit tests; this check
// passes only the exclusion. A few short haiku turns.
// Run:  npx tsx scripts/real/check-claude-md.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

requireConfirmation('Check that creation sessions do not load the repo’s CLAUDE.md (haiku, one subagent).');

const word = (stem: string) => `${stem}${randomInt(1000, 10000)}`;
/** The words after "MARKERS:" on the line that starts with `label`. */
const markers = (text: string, label: string): string[] => {
  const line = text.split(/\r?\n/).find((item) => item.trim().toUpperCase().startsWith(`${label}:`)) ?? '';
  return [...line.matchAll(/\b[a-z]+\d{4}\b/g)].map((match) => match[0]);
};

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('claude-md');
  check.add(() => box.cleanup());
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  const excluded = word('heron');
  const control = word('otter');
  const above = word('lynx');
  const line = (marker: string) => `# Notes\n\nThe marker word of this file is ${marker}.\n`;
  await writeFile(path.join(box.project, 'CLAUDE.md'), line(excluded), 'utf8');
  await mkdir(path.join(box.project, '.claude', 'agents'), { recursive: true });
  await writeFile(path.join(box.project, '.claude', 'CLAUDE.md'), line(control), 'utf8');
  await writeFile(path.join(box.dir, 'CLAUDE.md'), line(above), 'utf8');
  await writeFile(
    path.join(box.project, '.claude', 'agents', 'probe.md'),
    [
      '---',
      'name: probe',
      'description: Reports the marker words in its own instructions. Use it when asked to run the probe agent.',
      'tools: Glob',
      'model: haiku',
      '---',
      '',
      'Use no tool. Look only at your own instructions and the project memory loaded with them.',
      'Reply with one line: "MARKERS: " and every word that follows "The marker word of this file is", or "MARKERS: none".',
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
  console.log(`claudeMdExcludes: ${JSON.stringify((options.settings as { claudeMdExcludes?: unknown }).claudeMdExcludes)}`);
  // No file reads: the markers must come from the instructions, not from the files.
  options.tools = ['Agent'];
  options.maxTurns = 6;

  const prompt = [
    'Use no tool except Agent.',
    '1. Look only at your own instructions and the project memory loaded with them. Write one line: "MAIN: " and every word that follows "The marker word of this file is", or "MAIN: none".',
    '2. Use the Agent tool with subagent_type "probe" and the prompt "Report your markers." Then write one line: "PROBE: " and the words of its MARKERS line, or "PROBE: none".',
    'Write nothing else.',
  ].join('\n');
  let finalText = '';
  const q = check.query(query({ prompt: oneShot(prompt), options }), tracked);
  for await (const message of q) {
    if (message.type === 'result') {
      finalText = 'result' in message && typeof message.result === 'string' ? message.result : '';
      break;
    }
  }
  q.close();
  await tracked.killTree();

  console.log(`\nWords: excluded ${excluded}, control ${control}, above ${above}`);
  console.log('Tool calls:', calls);
  console.log(`Answer:\n${finalText}`);
  const main = markers(finalText, 'MAIN');
  const probe = markers(finalText, 'PROBE');
  const planted = new Set([excluded, control, above]);
  ok = report('the probe agent ran', calls.includes('main:Agent'), calls.join(', ') || 'no tool calls') && ok;
  ok = report('main: the control word is there (project memory loads)', main.includes(control), main.join(', ') || 'none') && ok;
  ok = report('main: the repo’s CLAUDE.md is not', !main.includes(excluded), main.join(', ') || 'none') && ok;
  ok = report('subagent: the control word is there', probe.includes(control), probe.join(', ') || 'none') && ok;
  ok = report('subagent: the repo’s CLAUDE.md is not', !probe.includes(excluded), probe.join(', ') || 'none') && ok;
  ok = report('only planted words were reported', [...main, ...probe].every((item) => planted.has(item)), [...main, ...probe].join(', ') || 'none') && ok;
  console.log(`Info: the CLAUDE.md above the repo was ${main.includes(above) ? '' : 'NOT '}seen by the main session and ${probe.includes(above) ? '' : 'NOT '}by the subagent.`);

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

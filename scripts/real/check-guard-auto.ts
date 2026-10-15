// Real check 1 (PLAN-phase-2, "Real runs"): the guard holds under `auto` mode.
//
// Starts one short session on haiku in a temp folder, with the same guard hook
// and `auto` permission mode SdkRunner uses, and asks it to try four things.
// Expected:
//   1. a shell command that is not the briefstack CLI is denied by the guard;
//   2. a write outside the projects folder is denied by the guard;
//   3. a write inside the projects folder goes through;
//   4. a web fetch by the main session is not decided by the guard: it either
//      reaches canUseTool or the classifier decides (both are recorded).
// Spends a few short turns of haiku. Run:  npx tsx scripts/real/check-guard-auto.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { guardHook, type GuardContext } from '../../src/creation/guard.js';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show } from './common.js';

requireConfirmation('Check the guard hook under auto mode (haiku, about four tool calls).');

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

const box = await sandbox('guard');
const executable = claudeExecutable();
let ok = true;
try {
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  let claimed: string | undefined;
  const denials: string[] = [];
  const asked: string[] = [];
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
  const outside = path.join(box.dir, 'outside', 'x.txt');
  const inside = path.join(box.projects, 'ok.txt');

  const options = buildQueryOptions({
    repoDir: box.project,
    executable,
    profile: { name: 'check', sessionModel: 'haiku', effort: 'low' },
    env: sessionEnv(box),
    additionalDirectories: [box.projects],
    hooks: { PreToolUse: [{ hooks: [guardHook(context, (denial) => denials.push(`${denial.toolName}: ${denial.summary}`))] }] },
    canUseTool: async (toolName, input) => {
      asked.push(`${toolName}: ${JSON.stringify(input).slice(0, 120)}`);
      return { behavior: 'deny', message: 'Not allowed in this check.' };
    },
    mcpServers: {},
    abortController: new AbortController(),
    spawn: (spawnOptions) => tracked.spawn(spawnOptions),
  });
  // The check is not the briefstack repo: no skill, no project settings.
  options.settingSources = [];
  options.maxTurns = 10;

  const prompt =
    'Do these four things in this order, one tool call each, then reply with one line per thing saying what happened. ' +
    `1) Run the shell command: echo hello. 2) Write the text "x" to the file ${outside.replaceAll('\\', '/')}. ` +
    `3) Write the text "ok" to the file ${inside.replaceAll('\\', '/')}. 4) Fetch https://example.com with WebFetch. ` +
    'If a tool is denied, say so and carry on with the next thing.';
  const q = query({ prompt: oneShot(prompt), options });
  for await (const message of q) {
    if (message.type === 'result') break;
  }
  q.close();
  await tracked.killTree();

  console.log('\nDenied by the guard:', denials);
  console.log('Reached canUseTool:', asked);
  ok = report('echo denied by the guard', denials.some((entry) => entry.startsWith('Bash') || entry.startsWith('PowerShell')), `${denials.length} denial(s)`) && ok;
  ok = report('write outside denied by the guard', denials.some((entry) => entry.includes('x.txt')), (await exists(outside)) ? 'THE FILE EXISTS' : 'no file') && ok;
  ok = report('write outside left no file', !(await exists(outside)), outside) && ok;
  ok = report('write inside went through', (await exists(inside)) && (await readFile(inside, 'utf8')) === 'ok', inside) && ok;
  report('web fetch by the main session', true, asked.some((entry) => entry.startsWith('WebFetch')) ? 'reached canUseTool' : 'decided by the classifier (not asked)');

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} finally {
  await box.cleanup();
}
process.exit(ok ? 0 : 1);

// Real check 1 (PLAN-phase-2, "Real runs"): the guard holds under `auto` mode.
//
// Starts one short session on haiku in a temp folder, with the same guard hook,
// tool list and `auto` permission mode SdkRunner uses, and asks it to try seven
// things. Expected:
//   1. a shell command that is not the briefstack CLI is denied by the guard;
//   2. a write outside the projects folder is denied by the guard;
//   3. a write inside the projects folder goes through;
//   4. a web fetch by the main session is denied by the guard (only the
//      researcher may use the web) and never reaches canUseTool;
//   5. AskUserQuestion reaches canUseTool in auto mode, and the answer we give
//      ("blue") comes back to the model;
//   6. a write in a `.git` folder inside the projects folder is denied by the
//      guard and leaves no file;
//   7. Monitor is denied by the guard and its command never runs. SdkRunner does
//      not even offer Monitor; this check adds it to `tools` so the second line
//      of defence, the guard, is what gets tested.
// Spends a few short turns of haiku. Run:  npx tsx scripts/real/check-guard-auto.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { guardHook, type GuardContext } from '../../src/creation/guard.js';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

requireConfirmation('Check the guard hook under auto mode (haiku, about seven tool calls).');

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('guard');
  check.add(() => box.cleanup());
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  let claimed: string | undefined;
  const denials: string[] = [];
  const asked: string[] = [];
  let finalText = '';
  const context: GuardContext = {
    isOwnSession: (id) => {
      claimed ??= id;
      return claimed === id;
    },
    sessionDir: (id) => path.join(box.sessions, id),
    projectsDir: box.projects,
    libraryDir: path.join(box.home, 'library'),
    cwd: box.project,
    grantedDirs: () => [],
    cancelled: () => false,
  };
  const tracked = spawnTracked();
  const outside = path.join(box.dir, 'outside', 'x.txt');
  const inside = path.join(box.projects, 'ok.txt');
  const gitHook = path.join(box.projects, 'app', '.git', 'hooks', 'pre-commit');
  const monitorMarker = path.join(box.dir, 'monitor-ran.txt');

  const options = buildQueryOptions({
    repoDir: box.project,
    executable,
    profile: { name: 'check', sessionModel: 'haiku', effort: 'low' },
    env: sessionEnv(box),
    additionalDirectories: [box.projects],
    hooks: { PreToolUse: [{ hooks: [guardHook(context, (denial) => denials.push(`${denial.toolName}: ${denial.summary}`))] }] },
    canUseTool: async (toolName, input) => {
      asked.push(`${toolName}: ${JSON.stringify(input).slice(0, 120)}`);
      if (toolName === 'AskUserQuestion') {
        const questions = (input as { questions?: { question: string }[] }).questions ?? [];
        return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map((q) => [q.question, 'blue'])) } };
      }
      return { behavior: 'deny', message: 'Not allowed in this check.' };
    },
    mcpServers: {},
    abortController: new AbortController(),
    spawn: (spawnOptions) => tracked.spawn(spawnOptions),
  });
  // The check is not the briefstack repo: no skill, no project settings.
  options.settingSources = [];
  options.maxTurns = 14;
  // Offer Monitor on purpose: SdkRunner leaves it out, and here the guard alone must stop it.
  options.tools = [...(options.tools as string[]), 'Monitor'];

  const slash = (value: string): string => value.replaceAll('\\', '/');
  const prompt =
    'Do these seven things in this order, one tool call each, then reply with one line per thing saying what happened. ' +
    `1) Run the shell command: echo hello. 2) Write the text "x" to the file ${slash(outside)}. ` +
    `3) Write the text "ok" to the file ${slash(inside)}. 4) Fetch https://example.com with WebFetch. 5) Use AskUserQuestion to ask which colour I prefer, red or blue, and tell me the answer. ` +
    `6) Write the text "#!/bin/sh" to the file ${slash(gitHook)}. ` +
    `7) Use the Monitor tool with the command: echo ran > "${slash(monitorMarker)}" ` +
    'If a tool is denied, say so and carry on with the next thing.';
  const q = check.query(query({ prompt: oneShot(prompt), options }), tracked);
  for await (const message of q) {
    if (message.type === 'result') {
      finalText = 'result' in message && typeof message.result === 'string' ? message.result : '';
      break;
    }
  }
  q.close();
  await tracked.killTree();

  console.log('\nDenied by the guard:', denials);
  console.log('Reached canUseTool:', asked);
  ok = report('echo denied by the guard', denials.some((entry) => entry.startsWith('Bash') || entry.startsWith('PowerShell')), `${denials.length} denial(s)`) && ok;
  ok = report('write outside denied by the guard', denials.some((entry) => entry.includes('x.txt')), (await exists(outside)) ? 'THE FILE EXISTS' : 'no file') && ok;
  ok = report('write outside left no file', !(await exists(outside)), outside) && ok;
  ok = report('write inside went through', (await exists(inside)) && (await readFile(inside, 'utf8')) === 'ok', inside) && ok;
  ok =
    report(
      'AskUserQuestion reached canUseTool and the answer came back',
      asked.some((entry) => entry.startsWith('AskUserQuestion')) && /blue/i.test(finalText),
      finalText.slice(0, 120) || 'no final text',
    ) && ok;
  ok =
    report(
      'web fetch by the main session denied by the guard',
      denials.some((entry) => entry.startsWith('WebFetch')) && !asked.some((entry) => entry.startsWith('WebFetch')),
      asked.some((entry) => entry.startsWith('WebFetch')) ? 'IT REACHED canUseTool' : `${denials.filter((entry) => entry.startsWith('WebFetch')).length} guard denial(s)`,
    ) && ok;
  ok = report('write in .git denied by the guard', denials.some((entry) => entry.includes('.git')), (await exists(gitHook)) ? 'THE FILE EXISTS' : 'no file') && ok;
  ok = report('write in .git left no file', !(await exists(gitHook)), gitHook) && ok;
  ok = report('Monitor denied by the guard', denials.some((entry) => entry.startsWith('Monitor')), (await exists(monitorMarker)) ? 'ITS COMMAND RAN' : 'its command did not run') && ok;
  ok = report('Monitor command did not run', !(await exists(monitorMarker)), monitorMarker) && ok;

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

// Real check 5 (PLAN-phase-2, "Real runs"; added after the failed H10 run 2 of
// 2026-10-16): the main session of a creation sees the briefstack-web tools
// and can call approve_spec.
//
// Starts one short haiku session in a temp folder with the options SdkRunner
// uses (guard hook, tool list, `auto` mode, the runner's environment and the
// real briefstack-web MCP server) and asks it to call approve_spec on a spec
// and a summary this script writes first. The browser's answer is played by
// this script: a change request with a random word. Expected:
//   1. the init message lists approve_spec and grant_directory (what SdkRunner
//      checks before the flow starts);
//   2. approve_spec reaches the runner side with the two files;
//   3. its answer comes back: the main session replies with the word;
//   4. the guard denies nothing and canUseTool is never asked for approve_spec
//      (it is pre-approved, as in SdkRunner).
// Spends a few short turns of haiku. Run:  npx tsx scripts/real/check-web-tools.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { systemPathEnv } from '../../src/config/paths.js';
import { guardHook, type GuardContext } from '../../src/creation/guard.js';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL, WEB_SERVER_NAME, createWebToolsServer } from '../../src/creation/webTools.js';
import { protectedDirs } from '../../src/scaffold/outputDir.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

requireConfirmation('Check that the main session sees and calls approve_spec (haiku, one tool call).');

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('web-tools');
  check.add(() => box.cleanup());
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  const word = `osprey${randomInt(1000, 10000)}`;
  // One fixed session folder, so the files exist before the session starts.
  const sessionDir = path.join(box.sessions, 'check');
  await mkdir(sessionDir, { recursive: true });
  const specFile = path.join(sessionDir, 'spec.json');
  const summaryFile = path.join(sessionDir, 'summary.md');
  await writeFile(specFile, '{"specVersion":1,"name":"check"}\n');
  await writeFile(summaryFile, 'A one-line summary for the check.\n');

  const pathEnv = systemPathEnv();
  let claimed: string | undefined;
  const denials: string[] = [];
  const asked: string[] = [];
  const approvals: { specFile: string; summaryFile: string }[] = [];
  let initTools: string[] = [];
  let serverStatus = 'not listed';
  let finalText = '';
  const context: GuardContext = {
    isOwnSession: (id) => {
      claimed ??= id;
      return claimed === id;
    },
    sessionDir: () => sessionDir,
    projectsDir: box.projects,
    libraryDir: path.join(box.home, 'library'),
    cwd: box.project,
    grantedDirs: () => [],
    cancelled: () => false,
  };
  const tracked = spawnTracked();
  const webTools = createWebToolsServer({
    io: {
      approveSpec: async (request) => {
        approvals.push(request);
        return { decision: 'change', text: `Rename it to ${word}` };
      },
      grantDirectory: async () => false,
      claimFolder: () => ({ ok: true }),
    },
    sessionDir: () => sessionDir,
    protectedDirs: protectedDirs(path.join(box.home, 'library'), box.project, pathEnv),
    projectsDir: box.projects,
    onGrant: () => undefined,
    pathEnv,
  });

  const options = buildQueryOptions({
    repoDir: box.project,
    executable,
    profile: { name: 'check', sessionModel: 'haiku', effort: 'low' },
    env: sessionEnv(box),
    additionalDirectories: [box.projects, box.sessions],
    hooks: { PreToolUse: [{ hooks: [guardHook(context, (denial) => denials.push(`${denial.toolName}: ${denial.summary}`))] }] },
    canUseTool: async (toolName) => {
      asked.push(toolName);
      return { behavior: 'deny', message: 'Not allowed in this check.' };
    },
    mcpServers: { [WEB_SERVER_NAME]: webTools },
    abortController: new AbortController(),
    spawn: (spawnOptions) => tracked.spawn(spawnOptions),
  });
  // The check is not the briefstack repo: no skill, no project settings.
  options.settingSources = [];
  options.maxTurns = 4;

  const slash = (value: string): string => value.replaceAll('\\', '/');
  const prompt =
    `Call the tool ${APPROVE_SPEC_TOOL} once with specFile "${slash(specFile)}" and summaryFile "${slash(summaryFile)}". ` +
    'It returns the user decision. Then reply with only the new name the user asked for, nothing else.';
  const q = check.query(query({ prompt: oneShot(prompt), options }), tracked);
  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init' && initTools.length === 0) {
      initTools = message.tools;
      serverStatus = message.mcp_servers.find((server) => server.name === WEB_SERVER_NAME)?.status ?? 'not listed';
    }
    if (message.type === 'result') {
      finalText = 'result' in message && typeof message.result === 'string' ? message.result : '';
      break;
    }
  }
  q.close();
  await tracked.killTree();

  console.log(`\nWord: ${word}`);
  console.log(`Init: ${WEB_SERVER_NAME} ${serverStatus}; its tools: ${initTools.filter((tool) => tool.startsWith('mcp__')).join(', ') || 'none'}`);
  console.log('Denied by the guard:', denials);
  console.log('Reached canUseTool:', asked);
  ok =
    report(
      'the init message lists both browser tools',
      initTools.includes(APPROVE_SPEC_TOOL) && initTools.includes(GRANT_DIRECTORY_TOOL),
      `${WEB_SERVER_NAME}: ${serverStatus}`,
    ) && ok;
  ok =
    report(
      'approve_spec reached the runner side with the two files',
      approvals.length === 1 && path.resolve(approvals[0]?.specFile ?? '') === specFile && path.resolve(approvals[0]?.summaryFile ?? '') === summaryFile,
      `${approvals.length} call(s)`,
    ) && ok;
  ok = report('the decision came back to the main session', finalText.includes(word), finalText.slice(0, 120) || 'no final text') && ok;
  ok = report('the guard denied nothing', denials.length === 0, denials.join(' | ') || 'no denials') && ok;
  ok = report('approve_spec needed no permission prompt', !asked.includes(APPROVE_SPEC_TOOL), asked.join(', ') || 'nothing asked') && ok;

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

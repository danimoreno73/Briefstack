// Real check 2 (PLAN-phase-2, "Real runs"): `spawnClaudeCodeProcess` lets the
// server end the whole Claude Code process tree, with no orphan.
//
// H0 showed that on Windows closing the SDK's query leaves a running command
// orphaned. This starts one short haiku session through our own spawn, has it
// run a command that sleeps for two minutes (a node process that records its
// pid), and then ends the tree the way the server does on stop.
// Expected: the sleeping command and Claude Code are both gone a few seconds later.
// Run:  npx tsx scripts/real/check-kill-tree.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, onlyThisCommand, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show } from './common.js';

requireConfirmation('Check that stopping a creation leaves no orphan process (haiku, one tool call).');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const box = await sandbox('kill');
const executable = claudeExecutable();
let ok = false;
try {
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  const pidFile = path.join(box.dir, 'sleeper.pid').replaceAll('\\', '/');
  const script = path.join(box.dir, 'sleeper.cjs');
  // The one command the session may run: nothing else is allowed, and only the shell tool exists.
  const command = `node "${script.replaceAll(String.fromCharCode(92), '/')}"`;
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000);\n`,
    'utf8',
  );

  const tracked = spawnTracked();
  const abort = new AbortController();
  const q = query({
    prompt: oneShot(`Run exactly this shell command, character for character, and wait for it: ${command}`),
    options: {
      cwd: box.project,
      pathToClaudeCodeExecutable: executable,
      env: sessionEnv(box),
      settingSources: [],
      model: 'haiku',
      effort: 'low',
      permissionMode: 'auto',
      maxTurns: 4,
      abortController: abort,
      spawnClaudeCodeProcess: (spawnOptions) => tracked.spawn(spawnOptions),
      // Only the shell exists, and only that one command is allowed; anything else is denied.
      tools: ['Bash', 'PowerShell'],
      canUseTool: onlyThisCommand(command),
    },
  });

  // Drive the session in the background until the sleeper has started.
  const driving = (async () => {
    try {
      for await (const message of q) if (message.type === 'result') break;
    } catch {
      // Closed under it: expected.
    }
  })();
  let sleeperPid = 0;
  for (let i = 0; i < 120 && sleeperPid === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    sleeperPid = Number((await readFile(pidFile, 'utf8').catch(() => '0')) || 0);
  }
  if (sleeperPid === 0) {
    report('the command started', false, 'the model never ran the sleeper within two minutes');
  } else {
    report('the command started', alive(sleeperPid), `pid ${sleeperPid}`);
    // What the server does on stop: close the query, then end the tree.
    q.close();
    await tracked.killTree();
    abort.abort();
    let gone = false;
    for (let i = 0; i < 20 && !gone; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      gone = !alive(sleeperPid);
    }
    ok = report('no orphan after the tree was killed', gone, gone ? 'the sleeper is gone' : `pid ${sleeperPid} is STILL RUNNING`);
    if (!gone) process.kill(sleeperPid);
  }
  await driving;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} finally {
  await box.cleanup();
}
process.exit(ok ? 0 : 1);

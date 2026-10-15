// Real check 3 (PLAN-phase-2, "Real runs"): the session effort reaches Claude
// Code when the model is Sonnet.
//
// H0 could not see the effort on Haiku (the init message reported none). This
// starts two tiny Sonnet sessions, with `effort: 'low'` and `effort: 'high'`, and
// prints the effort each init message reports. Each session answers one word.
// Run:  npx tsx scripts/real/check-effort.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show } from './common.js';

requireConfirmation('Check that the effort setting is visible on a Sonnet session (two one-word turns).');

const box = await sandbox('effort');
const executable = claudeExecutable();
let ok = true;
try {
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);
  for (const effort of ['low', 'high'] as const) {
    const q = query({
      prompt: oneShot('Reply with the single word: ok'),
      options: {
        cwd: box.project,
        pathToClaudeCodeExecutable: executable,
        env: sessionEnv(box),
        settingSources: [],
        model: 'sonnet',
        effort,
        maxTurns: 1,
      },
    });
    let reported: unknown = 'no init message';
    let model: unknown = '?';
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        reported = (message as { effort?: unknown }).effort;
        model = message.model;
      }
      if (message.type === 'result') break;
    }
    q.close();
    ok = report(`effort ${effort}`, reported === effort, `model ${String(model)}, init reports ${String(reported)}`) && ok;
  }
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} finally {
  await box.cleanup();
}
process.exit(ok ? 0 : 1);

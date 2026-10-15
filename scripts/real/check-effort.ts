// Real check 3 (PLAN-phase-2, "Real runs"): the session effort reaches Claude
// Code when the model is Sonnet.
//
// The init message of an SDK session does not report the effort (SDK 0.3.286:
// `SDKSystemMessage.effort` is only on Remote Control frames), which is why H0
// saw `undefined`. Hook inputs in a tool-use context do, after any downgrade for
// the model, so this registers a `Stop` hook and compares its `effort.level`
// with the requested one. Two tiny Sonnet sessions, `low` and `high`, each
// answering one word.
// Run:  npx tsx scripts/real/check-effort.ts --yes

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  claudeExecutable,
  effortRecorder,
  oneShot,
  readPlanUsage,
  report,
  requireConfirmation,
  sandbox,
  sessionEnv,
  show,
} from './common.js';

requireConfirmation('Check that the effort setting reaches a Sonnet session (two one-word turns).');

const box = await sandbox('effort');
const executable = claudeExecutable();
let ok = true;
try {
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);
  for (const effort of ['low', 'high'] as const) {
    const recorder = effortRecorder();
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
        hooks: { Stop: [{ hooks: [recorder.hook] }] },
      },
    });
    let model: unknown = '?';
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') model = message.model;
      if (message.type === 'result') break;
    }
    q.close();
    const level = recorder.level();
    ok = report(`effort ${effort}`, level === effort, `model ${String(model)}, Stop hook reports ${level ?? 'no effort'}`) && ok;
  }
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} finally {
  await box.cleanup();
}
process.exit(ok ? 0 : 1);

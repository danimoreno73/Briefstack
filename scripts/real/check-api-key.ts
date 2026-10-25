// Real check (BRIEF-release §2): API key mode. With ANTHROPIC_API_KEY set
// in this terminal to the user's own key, the session environment that
// briefstack web builds (cleanEnvironment) must reach Claude Code with the
// key, Claude Code must report API key mode, and one very short Haiku turn
// must answer. It spends one tiny Haiku request, billed to that key (a
// fraction of a cent); no plan usage is involved. The key is never printed,
// logged or written; nothing else is read from the user's account.
// Run in a terminal where ANTHROPIC_API_KEY is set:
//   npx tsx scripts/real/check-api-key.ts --yes

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { readAuthMode } from '../../src/creation/claudeAccount.js';
import { CheckStop, claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

requireConfirmation('Run one very short Haiku turn, billed to the ANTHROPIC_API_KEY set in this terminal.');

const check = startCheck();
let ok = true;
try {
  if ((process.env.ANTHROPIC_API_KEY ?? '') === '') {
    throw new CheckStop(2, 'ANTHROPIC_API_KEY is not set in this terminal. Set it to your own key, then run the check again.');
  }
  const executable = claudeExecutable();
  const box = await sandbox('api-key');
  check.add(() => box.cleanup());
  const env = sessionEnv(box);
  const keyKept = env.ANTHROPIC_API_KEY === process.env.ANTHROPIC_API_KEY;
  ok = report('the session environment keeps the key', keyKept, 'present (value not shown)') && ok;

  const mode = await readAuthMode({ cwd: box.project, executable, env });
  ok = report('Claude Code reports API key mode from the environment', mode.kind === 'apiKey' && mode.source === 'environment', JSON.stringify(mode)) && ok;

  const usage = await readPlanUsage(box, executable);
  ok = report('there are no plan limits to show', typeof usage === 'string', show(usage)) && ok;

  const started = Date.now();
  const options: Options = { cwd: box.project, pathToClaudeCodeExecutable: executable, env, settingSources: [], tools: [], model: 'haiku', maxTurns: 1, permissionMode: 'default' };
  const q = check.query(query({ prompt: oneShot('Reply with the single word: ready'), options }));
  let keySource: string | undefined;
  let answer = '';
  let outcome = 'no result';
  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init') keySource = message.apiKeySource;
    if (message.type === 'result') {
      outcome = message.subtype;
      if (message.subtype === 'success') answer = message.result;
      break;
    }
  }
  ok = report('the session itself used the key', keySource === 'ANTHROPIC_API_KEY', `apiKeySource ${keySource ?? 'not reported'}`) && ok;
  ok = report('one short Haiku turn answered', outcome === 'success' && /ready/i.test(answer), `${outcome} in ${Math.round((Date.now() - started) / 1000)} s: ${answer.slice(0, 60)}`) && ok;
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

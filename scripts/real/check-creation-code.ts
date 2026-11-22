// Real check (phase 10, M6): a small creation that writes a first version
// of the code, with Codex without its shell, through the real creation
// manager (the web app's), the real `/new-project` skill and its agents on
// the saver profile, the user's real Claude Code and real Codex CLI, in a
// temp home and a temp projects folder. What the tests with the fake runner
// and the fake Codex cannot show:
//   - that the `implementer` subagent sees and calls briefstack's in-process
//     tools (`run_command`, `delegate_to_codex` on `briefstack-web`), which
//     the docs do not say for an SDK server (decisions.md, "Phase 10: H0", 5);
//   - that the command-hook guard lets it write in the project (review of
//     M3, B1) and nowhere else;
//   - the two commits, a listed command run, a command off the list denied
//     without a dialog, Codex called without its shell, and the checks.
//
// Before anything is spent on Claude, Codex is turned on in the temp home
// and checked as the Settings card does (no model): the creation starts only
// when the check passed with its no-shell part. Plan usage is read before
// and after; above 70% of the 5-hour window or 95% of the week it does not
// start.
//
// The script plays the browser as the other real checks do (`autoAnswer`):
// recommended options, folders only inside the temp projects folder,
// permissions refused. At the spec it chooses "workspace and a first version
// of the code" with the list `node --test`, the check `node --test`, one fix
// pass and Codex ticked. The idea asks the implementer to run `npm --version`
// once (not on the list) and to hand `src/sum.js` to Codex: if it never
// tries either, that verdict FAILs with that fact (the model, not
// briefstack); nothing is retried.
//
// Spends: one short creation on the saver profile (interview, spec,
// generation, review, implement) and real Codex usage (about 20 000 to
// 80 000 Codex input tokens, mostly cached, per H0.1), plus free plan
// readings. It stops after 40 minutes. Nothing is pushed; the real library,
// projects and agent files are not touched.
// Run:  npx tsx scripts/real/check-creation-code.ts --yes

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CodexService, creationCodexOffered } from '../../src/codex/service.js';
import { updateConfig } from '../../src/config/index.js';
import { CODE_COMMIT_MESSAGE } from '../../src/creation/implement.js';
import { PROJECT_COMMIT_MESSAGE } from '../../src/scaffold/commit.js';
import { createWebCreations } from '../../src/creation/wiring.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { CheckStop, autoAnswer, claudeExecutable, processesMentioning, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show, startCheck } from './common.js';

requireConfirmation(
  'Phase 10 real check: one short creation that writes a first version of the code, with Codex without its shell, in a temp home. It spends one creation on the saver profile and real Codex usage with your ChatGPT login (about 20 000 to 80 000 Codex input tokens, mostly cached).',
);

const IDEA = [
  'A tiny Node.js command-line tool, plain JavaScript ES modules and no dependencies: `src/sum.js` exports a function that adds numbers,',
  '`bin/sum.js` prints the sum of the numbers given as arguments, and `test/sum.test.js` tests it with node:test.',
  'For the first version of the code: hand the writing of `src/sum.js` to Codex, and run `npm --version` once to see which npm is installed.',
  'Keep everything minimal.',
].join(' ');

/** The code choice the script approves at the spec (docs/api.md, "POST /api/creations/:id/answer"). */
const CODE = { commands: ['node --test'], checks: ['node --test'], fixPasses: 1, codex: true };
const OFF_LIST = 'npm --version';
const LIMIT_MS = 40 * 60_000;

/** A verdict the script cannot decide from outside. */
const notControlled = (name: string, detail: string): void => console.log(`NOT CONTROLLED  ${name}: ${detail}`);

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('creation-code');
  check.add(() => box.cleanup());
  const pathEnv = await sandboxLibrary(box);
  await updateConfig(path.join(box.home, 'config.json'), { activeProfile: 'saver', permissionPolicy: 'ask', codexEnabled: true, codexMode: 'unelevated' });

  // Codex first: nothing is spent on Claude before its check passed, with the no-shell part.
  const codex = new CodexService({ pathEnv });
  const view = await codex.check();
  console.log(`Codex check: ${JSON.stringify({ version: view.last?.version, login: view.last?.login.ok, sandbox: view.last?.sandbox.ok, noShell: view.last?.noShell })}`);
  ok = report('Codex is checked and its no-shell mode holds (no model)', creationCodexOffered(view), view.last?.noShell?.text ?? 'no check') && ok;
  if (!creationCodexOffered(view)) throw new CheckStop(2, 'Codex is not ready for creations (switch, login, sandbox or the no-shell check): nothing was spent on Claude.');

  const before = await readPlanUsage(box, executable);
  console.log(`Plan usage before: ${show(before)}`);
  if (typeof before !== 'string' && ((before.fiveHour ?? 0) > 70 || (before.sevenDay ?? 0) > 95)) {
    throw new CheckStop(2, 'Plan usage is above 70% of the 5-hour window or 95% of the week: not starting.');
  }

  const manager = await createWebCreations({
    pathEnv,
    repoDir: PACKAGE_ROOT,
    lang: 'en',
    codexForCreations: async () => creationCodexOffered(await codex.view()),
    implementCodex: () => codex.creationSession(),
  });
  check.add(() => manager.shutdown());
  const { id } = await manager.create(IDEA);
  const deadline = Date.now() + LIMIT_MS;
  const answered = new Set<string>();
  let offered = false;
  let replies = 0;
  /** Permission requests the page was asked while the implement step ran: there must be none. */
  const askedDuringImplement: string[] = [];
  while (manager.get(id).status !== 'finished' && Date.now() < deadline) {
    const state = manager.get(id);
    const pending = state.pending;
    if (pending !== undefined && !answered.has(pending.id)) {
      answered.add(pending.id);
      if (pending.kind === 'permission' && (state.currentStep === 'implement' || state.implement?.state === 'running')) {
        askedDuringImplement.push(`${pending.payload.toolName}: ${pending.payload.summary}`);
      }
      const spec = pending.kind === 'spec' ? await manager.readSpec(id).catch(() => undefined) : undefined;
      const decision = autoAnswer(pending, box.projects, { summary: spec?.summary ?? null });
      if (decision.kind === 'cancel') {
        console.log(`${pending.kind} → cancel: ${decision.reason.slice(0, 160)}`);
        manager.cancel(id);
      } else if (pending.kind === 'spec') {
        offered = spec?.code.offered === true && spec.code.codex;
        const answer = offered ? { decision: 'approve', code: CODE } : decision.answer;
        console.log(`spec → ${JSON.stringify(answer)}`);
        manager.answer(id, pending.id, answer);
      } else {
        console.log(`${pending.kind} → ${JSON.stringify(decision.answer).slice(0, 120)}`);
        manager.answer(id, pending.id, decision.answer);
      }
    } else if (pending === undefined && state.awaitingReply !== undefined && !answered.has(`reply:${state.awaitingReply.at}`)) {
      answered.add(`reply:${state.awaitingReply.at}`);
      replies += 1;
      console.log(`turn ended in text: ${state.awaitingReply.lastMessage.slice(0, 160)}`);
      manager.reply(id, 'Go on with the recommended options.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (manager.get(id).status !== 'finished') {
    console.log('Time is up: cancelling.');
    manager.cancel(id);
  }
  await manager.shutdown();
  const final = manager.get(id);
  const step = final.implement;
  console.log(`Creation: ${final.outcome ?? final.status}; implement: ${JSON.stringify({ state: step?.state, reason: step?.reason, limit: step?.limit, warning: step?.warning, toolCalls: step?.toolCalls })}`);

  ok = report('the spec page offered code and Codex', offered, String(offered)) && ok;
  ok = report('the creation completed', final.outcome === 'completed', final.outcome ?? final.status) && ok;
  ok = report('the implement step ran to its end', step?.state === 'done', step?.state ?? 'never asked') && ok;

  // The project and its two commits.
  const dir = await projectOf(box.projects);
  if (dir !== undefined) {
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    ok = report('two commits: the workspace, then the code apart', log[0] === CODE_COMMIT_MESSAGE && log.includes(PROJECT_COMMIT_MESSAGE), log.slice(0, 3).join(' | ')) && ok;
    const codeFiles = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    // The implementer (a subagent) wrote in the project: the command hook knew its folder (review of M3, B1).
    ok = report('the code commit holds what the implementer wrote', codeFiles.length > 0, codeFiles.join(', ') || 'empty') && ok;
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
    ok = report('the project tree is clean after the hand-off', status === '', status || 'clean') && ok;
    const brief = await readFile(path.join(dir, 'docs', 'BRIEF.md'), 'utf8').catch(() => '');
    notControlled('what the brief says is left', (step?.status ?? brief.slice(brief.indexOf('## Current status'), brief.indexOf('## Current status') + 300)).slice(0, 300));
  } else ok = report('the project folder was found', false, 'none') && ok;

  // The implementer's own tools reached it (an in-process SDK server and a subagent: H0, 5).
  const usedTools = (step?.runs.length ?? 0) + (step?.refused.length ?? 0) + (step?.codex.length ?? 0) > 0;
  ok = report('the implementer called briefstack’s tools (run_command or delegate_to_codex)', usedTools, `${step?.runs.length ?? 0} run(s), ${step?.refused.length ?? 0} refused, ${step?.codex.length ?? 0} Codex call(s)`) && ok;
  ok = report('a listed command ran in the project', (step?.runs ?? []).some((run) => CODE.commands.includes(run.command)), (step?.runs ?? []).map((run) => `${run.command} → ${run.exitCode}`).join(', ') || 'none') && ok;

  // The command off the list: denied (by run_command or by the guard, the implementer having no shell), and nobody asked.
  const events = await sessionLines(box.sessions, final.sessionId);
  const guardDenials = events.filter((line) => line.type === 'tool.denied' && line.agentType === 'implementer').map((line) => `${String(line.tool)} (${String(line.by)})`);
  const refused = (step?.refused ?? []).map((r) => r.command);
  const tried = refused.some((command) => command.includes('npm')) || guardDenials.length > 0;
  ok = report(`a command off the list (${OFF_LIST}) was denied`, tried, tried ? [...refused, ...guardDenials].join(', ') : 'the implementer never tried a command off the list (the model, not briefstack)') && ok;
  ok = report('nobody was asked during the implement step', askedDuringImplement.length === 0, askedDuringImplement.join(' | ') || 'no dialog') && ok;

  // Codex, without its shell.
  const calls = step?.codex ?? [];
  ok = report('Codex was called without its shell and ran no command', calls.length > 0 && calls.every((call) => call.commands === 0), calls.length === 0 ? 'the implementer never called Codex (the model, not briefstack)' : calls.map((call) => `#${call.n} ${call.outcome}, ${call.commands} command(s), ${call.usage?.input ?? 0} input tokens`).join('; ')) && ok;

  // The checks.
  const passes = step?.checks ?? [];
  ok = report('the checks ran after the implementer', passes.length > 0, passes.map((pass) => `run ${pass.pass}: ${pass.results.map((r) => `${r.command} → ${r.timedOut ? 'timed out' : r.exitCode}`).join(', ')}`).join('; ') || 'never') && ok;
  notControlled('whether the checks passed (the model wrote the code)', step?.warning === 'checksFailed' ? `still failing after ${step.fixPassesUsed} fix pass(es)` : 'passed');
  ok = report('no protected file was changed', (step?.protectedReverted ?? []).length === 0, (step?.protectedReverted ?? []).join(', ') || 'none') && ok;
  ok = report('no turn ended waiting for a text answer', replies === 0, String(replies)) && ok;
  const left = await processesMentioning(box.dir);
  ok = report('no process of the sandbox is left', left.length === 0, left.map((p) => `${p.pid} ${p.command.slice(0, 80)}`).join(' | ') || 'none') && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

/** The one project folder the creation made in the temp projects folder. */
async function projectOf(projects: string): Promise<string | undefined> {
  const entries = (await readdir(projects, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  return entries.length === 1 && entries[0] !== undefined ? path.join(projects, entries[0].name) : undefined;
}

/** The creation's `events.jsonl` lines. */
async function sessionLines(sessions: string, sessionId: string | undefined): Promise<Record<string, unknown>[]> {
  if (sessionId === undefined) return [];
  const text = await readFile(path.join(sessions, sessionId, 'events.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

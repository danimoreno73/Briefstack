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
//     M3, B1): no write of its own denied, and a file Codex was not asked
//     for in the code commit; and nothing written outside the projects
//     folder and the temp home, nor in this repo (review of M6, I3);
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
// readings. It stops after 45 minutes (the step itself after 20). When the
// spec page does not offer code with Codex it cancels at once, so nothing
// more is spent. The temp config sets the step's usage thresholds above the
// script's own start limits (review of M6, I4). Nothing is pushed; the real
// library, projects and agent files are not touched; Claude Code and Codex
// still write their own logs in the user's profile, as in the other real
// checks (they need the user's login).
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
import {
  CheckStop,
  GIT_STATUS_ARGS,
  autoAnswer,
  claudeExecutable,
  filesOutside,
  processesMentioning,
  readPlanUsage,
  report,
  requireConfirmation,
  sandbox,
  sandboxLibrary,
  show,
  startCheck,
} from './common.js';

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
const LIMIT_MS = 45 * 60_000;
/** The file the idea asks the implementer to hand to Codex; the others in the code commit are the implementer's own. */
const CODEX_FILE = 'src/sum.js';

/** A verdict the script cannot decide from outside. */
const notControlled = (name: string, detail: string): void => console.log(`NOT CONTROLLED  ${name}: ${detail}`);

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('creation-code');
  check.add(() => box.cleanup());
  const pathEnv = await sandboxLibrary(box);
  // The step's own usage gate above the script's start limits (70% / 95%), and a step shorter than the script's limit.
  await updateConfig(path.join(box.home, 'config.json'), {
    activeProfile: 'saver',
    permissionPolicy: 'ask',
    codexEnabled: true,
    codexMode: 'unelevated',
    usageWarnFiveHour: 95,
    usageWarnWeek: 99,
    implementMaxMinutes: 20,
  });

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

  // Writes outside the projects folder and the temp home, and in this repo, are compared before and after (review of M6, I3).
  const allowed = [box.projects, box.home, box.project, box.sessions];
  const filesBefore = await filesOutside(box.dir, allowed);
  const gitBefore = execFileSync('git', [...GIT_STATUS_ARGS], { cwd: PACKAGE_ROOT, encoding: 'utf8' });

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
  /** Anything the page was asked while the implement step ran (any kind): there must be nothing. */
  const askedDuringImplement: string[] = [];
  while (manager.get(id).status !== 'finished' && Date.now() < deadline) {
    const state = manager.get(id);
    const pending = state.pending;
    if (pending !== undefined && !answered.has(pending.id)) {
      answered.add(pending.id);
      const implementing = state.currentStep === 'implement' || state.implement?.state === 'running' || state.implement?.state === 'checking' || state.implement?.state === 'finishing';
      if (implementing) askedDuringImplement.push(pending.kind === 'permission' ? `permission ${pending.payload.toolName}: ${pending.payload.summary}` : pending.kind);
      const spec = pending.kind === 'spec' ? await manager.readSpec(id).catch(() => undefined) : undefined;
      const decision = autoAnswer(pending, box.projects, { summary: spec?.summary ?? null });
      if (decision.kind === 'cancel') {
        console.log(`${pending.kind} → cancel: ${decision.reason.slice(0, 160)}`);
        manager.cancel(id);
      } else if (pending.kind === 'spec') {
        offered = spec?.code.offered === true && spec.code.codex;
        if (!offered) {
          // Nothing to check without code and Codex: stop before the rest is spent (review of M6, I4).
          console.log(`spec → cancel: code offered ${String(spec?.code.offered)}, Codex offered ${String(spec?.code.codex)}`);
          manager.cancel(id);
        } else {
          const answer = { decision: 'approve', code: CODE };
          console.log(`spec → ${JSON.stringify(answer)}`);
          manager.answer(id, pending.id, answer);
        }
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

  // The session's own lines: the guard's denials of the implementer, with who denied them.
  const events = await sessionLines(box.sessions, final.sessionId);
  const implementerDenials = events.filter((line) => line.type === 'tool.denied' && line.agentType === 'implementer');
  const writeDenials = implementerDenials.filter((line) => line.tool === 'Write' || line.tool === 'Edit').map((line) => `${String(line.tool)} (${String(line.by)}): ${String(line.reason ?? '').slice(0, 100)}`);

  // The project and its two commits.
  const dir = await projectOf(box.projects);
  let codeFiles: string[] = [];
  if (dir !== undefined) {
    // Exactly two: HEAD the code (the step's code commit), HEAD~1 the workspace (its workspace commit).
    const log = execFileSync('git', ['log', '--format=%H %s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    const [head, parent] = log.map((line) => ({ sha: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }));
    const twoCommits =
      log.length === 2 &&
      head?.subject === CODE_COMMIT_MESSAGE &&
      parent?.subject === PROJECT_COMMIT_MESSAGE &&
      step?.codeCommit !== undefined &&
      head.sha.startsWith(step.codeCommit) &&
      step.workspaceCommit !== undefined &&
      parent.sha.startsWith(step.workspaceCommit);
    ok = report('two commits: the workspace, then the code apart', twoCommits, log.slice(0, 3).join(' | ')) && ok;
    codeFiles = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    // The implementer (a subagent) wrote in the project itself: the command hook knew its folder (review of M3, B1). Codex's
    // file tool bypasses the hook, so a file Codex was not asked for must be there, and no write of the implementer denied.
    const ownFiles = codeFiles.filter((file) => file !== CODEX_FILE);
    ok = report('the code commit holds what the implementer wrote', ownFiles.length > 0 && writeDenials.length === 0, `${codeFiles.join(', ') || 'empty'}${writeDenials.length > 0 ? `; denied: ${writeDenials.join(' | ')}` : ''}`) && ok;
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
    ok = report('the project tree is clean after the hand-off', status === '', status || 'clean') && ok;
    const brief = await readFile(path.join(dir, 'docs', 'BRIEF.md'), 'utf8').catch(() => '');
    notControlled('what the brief says is left', (step?.status ?? brief.slice(brief.indexOf('## Current status'), brief.indexOf('## Current status') + 300)).slice(0, 300));
  } else ok = report('the project folder was found', false, 'none') && ok;

  // The implementer's own tools reached it (an in-process SDK server and a subagent: H0, 5).
  const usedTools = (step?.runs.length ?? 0) + (step?.refused.length ?? 0) + (step?.codex.length ?? 0) > 0;
  ok = report('the implementer called briefstack’s tools (run_command or delegate_to_codex)', usedTools, `${step?.runs.length ?? 0} run(s), ${step?.refused.length ?? 0} refused, ${step?.codex.length ?? 0} Codex call(s)`) && ok;
  ok = report('a listed command ran in the project', (step?.runs ?? []).some((run) => CODE.commands.includes(run.command)), (step?.runs ?? []).map((run) => `${run.command} → ${run.exitCode}`).join(', ') || 'none') && ok;

  // The command off the list: refused by run_command (the implementer's only route to a command: it has no shell), by
  // briefstack and never by a dialog (review of M6, I2).
  const refused = (step?.refused ?? []).map((r) => r.command);
  const byUser = implementerDenials.filter((line) => line.by === 'user').map((line) => String(line.tool));
  const tried = refused.some((command) => command.includes('npm'));
  ok = report(
    `a command off the list (${OFF_LIST}) was denied`,
    tried && byUser.length === 0,
    tried ? `${refused.join(', ')}${byUser.length > 0 ? `; denied in a dialog: ${byUser.join(', ')}` : ''}` : `${refused.join(', ') || 'nothing refused'}: the implementer never tried npm off the list (the model, not briefstack)`,
  ) && ok;
  ok = report('nobody was asked during the implement step', askedDuringImplement.length === 0, askedDuringImplement.join(' | ') || 'no dialog') && ok;

  // Codex, without its shell: at least one call that completed with its usage read, none ran a command, and the file
  // handed to it is in the code commit (review of M6, I1). That no shell was offered at all is shown by the no-shell
  // check above, run with the same arguments.
  const calls = step?.codex ?? [];
  const completed = calls.some((call) => call.outcome === 'completed' && call.usage !== undefined);
  ok = report(
    'Codex was called without its shell and ran no command',
    completed && calls.every((call) => call.commands === 0) && codeFiles.includes(CODEX_FILE),
    calls.length === 0
      ? 'the implementer never called Codex (the model, not briefstack)'
      : `${calls.map((call) => `#${call.n} ${call.outcome}, ${call.commands} command(s), ${call.usage?.input ?? 0} input tokens`).join('; ')}; ${CODEX_FILE} ${codeFiles.includes(CODEX_FILE) ? 'in' : 'not in'} the code commit`,
  ) && ok;

  // The checks.
  const passes = step?.checks ?? [];
  ok = report('the checks ran after the implementer', passes.length > 0, passes.map((pass) => `run ${pass.pass}: ${pass.results.map((r) => `${r.command} → ${r.timedOut ? 'timed out' : r.exitCode}`).join(', ')}`).join('; ') || 'never') && ok;
  notControlled('whether the checks passed (the model wrote the code)', step?.warning === 'checksFailed' ? `still failing after ${step.fixPassesUsed} fix pass(es)` : 'passed');
  ok = report(
    'no protected file was changed',
    (step?.protectedReverted ?? []).length === 0 && step?.revertFailed !== true,
    `${(step?.protectedReverted ?? []).join(', ') || 'none'}${step?.revertFailed === true ? '; the put-back failed' : ''}`,
  ) && ok;
  const added = (await filesOutside(box.dir, allowed)).filter((file) => !filesBefore.includes(file));
  ok = report('nothing was written in the work folder outside the projects folder and the temp home', added.length === 0, added.join(', ') || 'none') && ok;
  const gitAfter = execFileSync('git', [...GIT_STATUS_ARGS], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  ok = report('the repo git status did not change', gitAfter === gitBefore, gitAfter.trim() || 'clean') && ok;
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

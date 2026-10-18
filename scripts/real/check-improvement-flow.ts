// Real check (BRIEF-phase-5 §3.3, §5): one cheap real creation with the
// flow's files as they are in the folder this script runs from.
//
// The proposal page offers it for a change to an agent (other than only the
// interviewer), the skill or a library template, and starts it from the
// proposal's worktree, so the creation uses the improved files. It can also
// be run by hand from the repo: `npx tsx scripts/real/check-improvement-flow.ts --yes`.
//
// It runs in a temp BRIEFSTACK_HOME (its own library, projects and sessions);
// the real library and projects are not touched. The session runs on the
// saver profile; the agents use the models their files hold (this script
// never rewrites them). It plays the browser as the two-creations check does
// (`autoAnswer`): recommended options, folders only inside the temp projects
// folder, the spec approved when it names no folder outside, permissions
// refused, a turn that ends in text answered with "Go on with the
// recommended options.". Expected: the creation ends `completed` with a
// project note in the temp library and a clean library tree, and no turn
// ended waiting for a text answer.
// It stops after 25 minutes. Plan usage is printed before and after; above
// 70% of the 5-hour window it does not start.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { updateConfig } from '../../src/config/index.js';
import { createWebCreations } from '../../src/creation/wiring.js';
import { listProjects } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { CheckStop, autoAnswer, claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show, startCheck } from './common.js';

requireConfirmation('Run one short real creation on the saver profile with the flow files of this folder, in a temp home.');

const IDEA = 'A one-page checklist for watering house plants each week. Keep it minimal.';
const LIMIT_MS = 25 * 60_000;

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('improvement-flow');
  check.add(() => box.cleanup());
  const before = await readPlanUsage(box, executable);
  console.log(`Plan usage before: ${show(before)}`);
  if (typeof before !== 'string' && (before.fiveHour ?? 0) > 70) throw new CheckStop(2, 'The 5-hour window is above 70%: not starting.');
  console.log(`Flow files from: ${PACKAGE_ROOT}`);
  const pathEnv = await sandboxLibrary(box);
  await updateConfig(path.join(box.home, 'config.json'), { activeProfile: 'saver', permissionPolicy: 'ask' });
  const manager = await createWebCreations({ pathEnv, repoDir: PACKAGE_ROOT, lang: 'en' });
  check.add(() => manager.shutdown());

  const { id } = await manager.create(IDEA);
  const deadline = Date.now() + LIMIT_MS;
  const answered = new Set<string>();
  let replies = 0;
  while (manager.get(id).status !== 'finished' && Date.now() < deadline) {
    const state = manager.get(id);
    const pending = state.pending;
    if (pending !== undefined && !answered.has(pending.id)) {
      answered.add(pending.id);
      const summary = pending.kind === 'spec' ? await manager.readSpec(id).then((view) => view.summary, () => null) : undefined;
      const decision = autoAnswer(pending, box.projects, { summary });
      if (decision.kind === 'cancel') {
        console.log(`${pending.kind} → cancel: ${decision.reason.slice(0, 160)}`);
        manager.cancel(id);
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
  console.log(`Creation: ${final.outcome ?? final.status} (${final.startedAt} → ${final.finishedAt ?? '?'}); denials: ${final.denied.length}`);
  ok = report('the creation completed', final.outcome === 'completed', final.outcome ?? final.status) && ok;
  const projects = (await listProjects(path.join(box.home, 'library'))).filter((project) => project.slug !== 'seed-tracker');
  ok = report('one project note in the temp library', projects.length === 1, projects.map((p) => p.slug).join(', ') || 'none') && ok;
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: path.join(box.home, 'library'), encoding: 'utf8' }).trim();
  ok = report('the temp library git tree is clean', status === '', status || 'clean') && ok;
  ok = report('no turn ended waiting for a text answer', replies === 0, String(replies)) && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

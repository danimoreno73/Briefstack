// Real check (BRIEF-phase-6 §5): one cheap real creation on the saver
// profile in which the architect should propose an approved library skill.
//
// In a temp BRIEFSTACK_HOME, the library gets one real public skill
// (anthropics/skills, skills/brand-guidelines, fetched without a token,
// reviewed by the fake reviewer, approved). Then one creation runs with the
// flow files of this folder, with an idea that needs that skill. The script
// plays the browser as the other real checks do (`autoAnswer`): recommended
// options, folders only inside the temp projects folder, the spec approved,
// permissions refused, a turn that ends in text answered "Go on with the
// recommended options.". Expected: the spec the user saw lists the skill,
// the creation completes, the project records it as installed and the
// validator finds it intact.
// It stops after 25 minutes. Plan usage is printed before and after; above
// 70% of the 5-hour window or 95% of the week it does not start. The real
// library and projects are not touched; the agent files are never rewritten.
//
// Run:  npx tsx scripts/real/check-skill-creation.ts --yes

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { updateConfig } from '../../src/config/index.js';
import { createWebCreations } from '../../src/creation/wiring.js';
import { listProjects } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { readInstalled } from '../../src/skills/install.js';
import { FakeSkillReviewer } from '../../src/skills/modelReview.js';
import { SkillService } from '../../src/skills/service.js';
import { validateProject } from '../../src/validate/index.js';
import { CheckStop, autoAnswer, claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show, startCheck } from './common.js';

requireConfirmation('Fetch one real public skill, then run one short real creation on the saver profile, in a temp home.');

const SKILL_URL = 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines';
const IDEA =
  'A small Claude Code workspace for writing one-page product notes that must follow Anthropic’s official brand colours and typography. Keep it minimal.';
const LIMIT_MS = 25 * 60_000;

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('skill-creation');
  check.add(() => box.cleanup());
  const before = await readPlanUsage(box, executable);
  console.log(`Plan usage before: ${show(before)}`);
  if (typeof before !== 'string' && ((before.fiveHour ?? 0) > 70 || (before.sevenDay ?? 0) > 95)) {
    throw new CheckStop(2, 'Plan usage is above 70% of the 5-hour window or 95% of the week: not starting.');
  }
  const pathEnv = await sandboxLibrary(box);
  const libraryDir = path.join(box.home, 'library');
  await updateConfig(path.join(box.home, 'config.json'), { activeProfile: 'saver', permissionPolicy: 'ask' });
  const skills = new SkillService({ libraryDir: async () => libraryDir, reviewer: new FakeSkillReviewer() });
  const added = await skills.add(SKILL_URL);
  const name = added.detail?.record.name ?? '';
  await skills.approve(name);
  console.log(`Approved library skill: ${name}`);

  const manager = await createWebCreations({ pathEnv, repoDir: PACKAGE_ROOT, lang: 'en', skills });
  check.add(() => manager.shutdown());
  const { id } = await manager.create(IDEA);
  const deadline = Date.now() + LIMIT_MS;
  const answered = new Set<string>();
  let proposed: string[] = [];
  let replies = 0;
  while (manager.get(id).status !== 'finished' && Date.now() < deadline) {
    const state = manager.get(id);
    const pending = state.pending;
    if (pending !== undefined && !answered.has(pending.id)) {
      answered.add(pending.id);
      const view = pending.kind === 'spec' ? await manager.readSpec(id).catch(() => undefined) : undefined;
      if (view !== undefined) {
        proposed = view.librarySkills.map((skill) => skill.name);
        console.log(`spec: library skills ${JSON.stringify(view.librarySkills)}`);
      }
      const decision = autoAnswer(pending, box.projects, { summary: view?.summary ?? null });
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
  console.log(`Creation: ${final.outcome ?? final.status}; denials: ${final.denied.length}`);
  ok = report('the architect proposed the approved library skill', proposed.includes(name), proposed.join(', ') || 'none') && ok;
  ok = report('the creation completed', final.outcome === 'completed', final.outcome ?? final.status) && ok;
  const project = (await listProjects(libraryDir)).find((p) => p.slug !== 'seed-tracker');
  const dir = project?.status?.path;
  ok = report('one project note in the temp library', dir !== undefined, project?.slug ?? 'none') && ok;
  if (dir !== undefined) {
    const installed = await readInstalled(dir).catch(() => []);
    ok = report('the project has the skill installed', installed.some((s) => s.name === name), installed.map((s) => `${s.name} → ${s.location}`).join(', ') || 'none') && ok;
    const result = await validateProject(dir, { pathEnv });
    ok = report('the validator finds no errors', result.errors === 0, result.findings.map((f) => f.rule).join(', ') || 'clean') && ok;
  }
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: libraryDir, encoding: 'utf8' }).trim();
  ok = report('the temp library git tree is clean', status === '', status || 'clean') && ok;
  ok = report('no turn ended waiting for a text answer', replies === 0, String(replies)) && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

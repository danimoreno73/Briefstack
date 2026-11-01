// Real check (PLAN-phase-7 M9, 5): a task session lists only the project's
// own skills (decisions.md, "Phase 7: skills that are not the project's").
//
// The sample project has one skill, `sample-skill`, which answers with a
// random marker word. Controls, so the check cannot pass on nothing:
//   1. a control session WITHOUT briefstack's task layers (a plain SDK
//      session in the project folder with its settings, no `skills`
//      option, bundled skills on) lists `sample-skill` AND other skills
//      (Claude Code's bundled ones, built-in plugins, synced ones): what
//      the layers must take away;
//   2. the task's session lists `sample-skill` and really uses it (a Skill
//      call that is not refused).
// Expected: the init message of the task's session lists exactly
// `sample-skill`, nothing else.
// Saver profile, the real `briefstack web` in a temp home (tasks-common.ts).
// Run:  npx tsx scripts/real/check-task-skills.ts --yes

import { randomInt } from 'node:crypto';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { controlSession, discard, driveRound, newTap, sampleProject, startTask, startWeb, usageGate } from './tasks-common.js';

requireConfirmation('Phase 7 real check 5: a task session lists only the project skills (saver profile, one control session and one short task session), in a temp home.');

const SKILL = 'sample-skill';

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-skills');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const word = `skillword${randomInt(100000, 1000000)}`;
  const tap = newTap();
  const web = await startWeb(check, box, tap);
  const project = await sampleProject(box, 'sample-skills', {
    [`.claude/skills/${SKILL}/SKILL.md`]: `---\nname: ${SKILL}\ndescription: Gives the project's marker word. Use when asked to run ${SKILL}.\n---\n\nReply with exactly this word and nothing else: ${word}\n`,
  });

  // Control 1: without the task's layers, more skills than the project's are listed.
  const control = await controlSession(check, box, executable, { cwd: project.dir, tools: ['Skill'], allowTools: [], prompt: 'Reply with the single word OK. Use no tool.', maxTurns: 1 });
  const controlSkills = [...(control.init?.skills ?? [])].sort();
  const others = controlSkills.filter((name) => name !== SKILL);
  console.log(`Control session skills (${controlSkills.length}): ${controlSkills.join(', ') || 'none'}`);
  ok = report('control: the project skill is listed without the task layers', controlSkills.includes(SKILL), '') && ok;
  ok = report('control: other skills (not the project\'s) are listed without the task layers', others.length > 0, others.join(', ') || 'none') && ok;

  const id = await startTask(web, project.slug, `Use the Skill tool once to run the skill "${SKILL}", then reply with the word it gives you. Do not change any file.`);
  const { task } = await driveRound(web, id, () => 'deny');
  const sessionId = task.rounds[0]?.sessionId;
  const init = tap.inits.find((entry) => entry.sessionId === sessionId);
  const skills = [...(init?.skills ?? [])].sort();
  console.log(`Task session: model ${init?.model ?? '?'}, permission mode ${init?.permissionMode ?? '?'}`);
  console.log(`Task session tools: ${(init?.tools ?? []).join(', ')}`);
  console.log(`Task session skills (${skills.length}): ${skills.join(', ') || 'none'}`);
  ok = report('the task session sent its init message', init !== undefined, sessionId ?? 'no session id') && ok;
  ok = report('the task session lists exactly the project skill', JSON.stringify(skills) === JSON.stringify([SKILL]), skills.join(', ') || 'none') && ok;
  const skillCalls = tap.calls.filter((call) => call.sessionId === sessionId && call.name === 'Skill');
  const used = skillCalls.filter((call) => call.input.skill === SKILL && !tap.errors.has(call.id));
  ok = report('control: the task session used the project skill', used.length >= 1, skillCalls.map((call) => `${String(call.input.skill)}${tap.errors.has(call.id) ? ' (refused)' : ''}`).join(', ') || 'no Skill call') && ok;
  const summary = task.rounds[0]?.summary ?? '';
  console.log(`Round: ${task.state}; summary ${JSON.stringify(summary.slice(0, 200))}; the marker word is ${summary.includes(word) ? '' : 'NOT '}in it (information).`);

  await discard(web, id);
  await web.stop();
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

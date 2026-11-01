// Real check (PLAN-phase-7 M9, 5): a task session's model gets only the
// project's own skills (decisions.md, "Phase 7: skills that are not the
// project's"), and a call to any other skill is refused by the task guard.
//
// The sample project has one skill, `sample-skill`, which gives a random
// marker word. What is measured:
//   - the skills in the MODEL'S CONTEXT: `getContextUsage()` (its `skills`
//     part, sdk.d.ts `SDKControlGetContextUsageResponse`), asked once the
//     session's first turn ended, while it is still open;
//   - the init message: its `skills`, `slash_commands` and Claude Code's
//     version (recorded);
//   - a call to `Skill` with `doctor`, which the session is asked to try.
// The verdict, fixed before the run (step 09):
//   (a) the task session's context holds only the project's skill;
//   (b) the `doctor` call is refused by the task guard, and does not run;
//   (c) control: a session WITHOUT the task's layers (a plain SDK session
//       in the project folder, no `skills` option, bundled skills on) has
//       `design` and `doctor` in its context, so (a) is not passed on
//       nothing.
// Skills the task's init message lists beyond the project's are an
// OBSERVATION, not a failure, only when (a), (b) and (c) pass and each one
// is a built-in command (in `slash_commands`): sdk.d.ts documents that with
// bundled skills off, "built-in slash commands stay typable but are hidden
// from the model". Anything else, or anything that cannot be read, fails.
// Saver profile, the real `briefstack web` in a temp home (tasks-common.ts).
// Run:  npx tsx scripts/real/check-task-skills.ts --yes

import { randomInt } from 'node:crypto';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { controlSession, discard, driveRound, newTap, sampleProject, sessionEventTypes, startTask, startWeb, usageGate, type ContextSkills } from './tasks-common.js';

requireConfirmation('Phase 7 real check 5: a task session gets only the project skills (saver profile, one control session and one short task session), in a temp home.');

const SKILL = 'sample-skill';
const FOREIGN = 'doctor';
/** What the task guard says when it refuses a skill (src/tasks/guard.ts), from the callback or the command hook. */
const GUARD_REFUSAL = /Only the project's own skills can be used in a task|briefstack task guard/;

const names = (context: ContextSkills | null | string | undefined): string[] | undefined =>
  typeof context === 'object' && context !== null ? context.skillFrontmatter.map((skill) => skill.name).sort() : undefined;
const describe = (context: ContextSkills | null | string | undefined): string =>
  typeof context === 'object' && context !== null
    ? `${context.includedSkills} of ${context.totalSkills} included, ${context.tokens} tokens: ${context.skillFrontmatter.map((skill) => `${skill.name} (${skill.source}, ${skill.tokens})`).join(', ') || 'none'}`
    : String(context ?? 'no reading');

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-skills');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const word = `skillword${randomInt(100000, 1000000)}`;
  const tap = newTap({ contextUsage: true });
  const web = await startWeb(check, box, tap);
  const project = await sampleProject(box, 'sample-skills', {
    [`.claude/skills/${SKILL}/SKILL.md`]: `---\nname: ${SKILL}\ndescription: Gives the project's marker word. Use when asked to run ${SKILL}.\n---\n\nThe project's marker word is ${word}.\n`,
  });

  // (c) Control: without the task's layers, the model's context holds other skills, design and doctor among them.
  const control = await controlSession(check, box, executable, { cwd: project.dir, tools: ['Skill'], allowTools: [], prompt: 'Reply with the single word OK. Use no tool.', maxTurns: 1 });
  const controlInit = [...(control.init?.skills ?? [])].sort();
  const controlContext = names(control.contextSkills);
  console.log(`Control session: Claude Code ${control.init?.claudeCodeVersion ?? '?'}`);
  console.log(`Control init skills (${controlInit.length}): ${controlInit.join(', ') || 'none'}`);
  console.log(`Control context skills: ${describe(control.contextSkills)}`);
  ok = report('control: the project skill is listed without the task layers', controlInit.includes(SKILL), '') && ok;
  ok = report('control: other skills (not the project\'s) are listed without the task layers', controlInit.some((name) => name !== SKILL), '') && ok;
  const c = controlContext !== undefined && controlContext.includes('design') && controlContext.includes(FOREIGN) && controlContext.includes(SKILL);
  ok = report('(c) control: design and doctor ARE in the model\'s context without the task layers', c, controlContext?.join(', ') ?? describe(control.contextSkills)) && ok;

  const id = await startTask(
    web,
    project.slug,
    [
      'Do these two things in order, one tool call each:',
      `1. Use the Skill tool to run the skill "${SKILL}" and note the marker word it gives.`,
      `2. Use the Skill tool with the skill name "${FOREIGN}", exactly once, even if it is not in your list of skills. If it is refused, do not retry and do not try another way.`,
      'Do not change any file. Then reply with the marker word, what happened in step 2, and the names of the skills your skill list shows you.',
    ].join('\n'),
  );
  const { task } = await driveRound(web, id, () => 'deny', undefined, async () => {
    await Promise.all([...(tap.contextUsage?.values() ?? [])]);
  });
  const sessionId = task.rounds[0]?.sessionId;
  const init = tap.inits.find((entry) => entry.sessionId === sessionId);
  const taskContext = sessionId === undefined ? undefined : await tap.contextUsage?.get(sessionId);
  const contextNames = names(taskContext);
  console.log(`Task session: Claude Code ${init?.claudeCodeVersion ?? '?'}, model ${init?.model ?? '?'}, permission mode ${init?.permissionMode ?? '?'}`);
  console.log(`Task session tools: ${(init?.tools ?? []).join(', ')}`);
  console.log(`Task init skills: ${(init?.skills ?? []).join(', ') || 'none'}`);
  console.log(`Task init slash_commands (${init?.slashCommands.length ?? 0}): ${(init?.slashCommands ?? []).join(', ') || 'none'}`);
  console.log(`Task context skills: ${describe(taskContext)}`);
  ok = report('the task session sent its init message', init !== undefined, sessionId ?? 'no session id') && ok;

  // (a) The model's context holds only the project's skill.
  const a = contextNames !== undefined && JSON.stringify(contextNames) === JSON.stringify([SKILL]);
  ok = report('(a) the task session\'s context holds only the project skill', a, contextNames?.join(', ') ?? describe(taskContext)) && ok;

  const skillCalls = tap.calls.filter((call) => call.sessionId === sessionId && call.name === 'Skill');
  for (const call of skillCalls) console.log(`   Skill ${JSON.stringify(call.input.skill)}: ${tap.errors.has(call.id) ? `refused: ${tap.errors.get(call.id)}` : 'ran'}`);
  const used = skillCalls.filter((call) => call.input.skill === SKILL && !tap.errors.has(call.id));
  ok = report('control: the task session used the project skill', used.length >= 1, skillCalls.map((call) => String(call.input.skill)).join(', ') || 'no Skill call') && ok;

  // (b) The call to doctor is refused by the task guard and does not run.
  const foreign = skillCalls.filter((call) => call.input.skill === FOREIGN || call.input.skill === `/${FOREIGN}`);
  const events = await sessionEventTypes(box, sessionId);
  console.log(`Panel events of the session: ${events.join(', ')}`);
  // The refusal's text in the call's result is the guard's own (callback or command hook); the panel's denial line backs it.
  const b = foreign.length >= 1 && foreign.every((call) => GUARD_REFUSAL.test(tap.errors.get(call.id) ?? ''));
  ok = report('(b) the Skill call to doctor was refused by the task guard and did not run', b, foreign.length === 0 ? 'NO CALL TO doctor' : foreign.map((call) => tap.errors.get(call.id) ?? 'IT RAN').join(' | ')) && ok;
  console.log(`   the panel ${events.includes('tool.denied:Skill') ? 'has' : 'has NO'} a tool.denied:Skill line (information)`);

  // The init listing: an observation only when (a), (b) and (c) hold and the docs back it.
  const extra = (init?.skills ?? []).filter((name) => name !== SKILL);
  if (extra.length === 0) {
    report('the task init lists only the project skill', true, '');
  } else {
    const commands = new Set((init?.slashCommands ?? []).map((name) => name.replace(/^\//, '')));
    const backed = a && b && c && extra.every((name) => commands.has(name));
    ok =
      report(
        'the task init lists more than the project skill: an observation only if (a), (b), (c) hold and each is a built-in command',
        backed,
        `${extra.join(', ')}; in slash_commands: ${extra.map((name) => `${name} ${commands.has(name) ? 'yes' : 'NO'}`).join(', ')}`,
      ) && ok;
    if (backed) {
      console.log(
        `OBSERVATION: the init lists ${extra.join(', ')}, built-in commands kept typable; the model's context does not hold them. sdk.d.ts, disableBundledSkills: "bundled skills and workflows are removed entirely; built-in slash commands stay typable but are hidden from the model".`,
      );
    }
  }
  const summary = task.rounds[0]?.summary ?? '';
  console.log(`Round: ${task.state}; summary ${JSON.stringify(summary.slice(0, 600))}`);

  await discard(web, id);
  await web.stop();
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

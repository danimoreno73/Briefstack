// Real check (PLAN-phase-7 M9, 5): a task session's model gets only the
// project's own skills (decisions.md, "Phase 7: skills that are not the
// project's"), and a call to any other skill is refused and does not run.
//
// The sample project has one skill, `sample-skill`, which gives a random
// marker word. What is measured:
//   - the skills in the MODEL'S CONTEXT: `getContextUsage()` (its `skills`
//     part, sdk.d.ts `SDKControlGetContextUsageResponse`), asked once the
//     session's first turn ended, while it is still open;
//   - the init message: its `skills`, `slash_commands` and Claude Code's
//     version (recorded);
//   - three `Skill` calls the task session is asked to make, each to a skill
//     that is not on the task's list:
//       (i)   `doctor`, which Claude Code refuses to the model by design
//             (`disable-model-invocation`);
//       (ii)  a bundled skill the model CAN invoke without the task's layers:
//             the first of `claude-api`, `simplify` that the control's context
//             holds (the docs: a `disable-model-invocation` skill's
//             description is not in context, so one that is in context is
//             not marked so);
//       (iii) `late-skill`, a second project skill the script writes into
//             the task's worktree once the session has started: it is the
//             project's, but not on the task's list.
// The verdict, fixed before the run (step 10):
//   (a) the task session's context holds only the task's skill;
//   (b) each of the three calls is refused by some layer and does not run;
//       the layer is recorded (the task guard, Claude Code before the hooks,
//       or another), from the call's result and the panel's lines. A call
//       that runs, a call with no result, or no call at all, fails;
//   (c) control: a session WITHOUT the task's layers (a plain SDK session
//       in the project folder, no `skills` option, bundled skills on) has
//       `design` and `doctor` in its context. A control that cannot be read
//       fails.
// Skills the task's init message lists beyond the project's are an
// OBSERVATION, not a failure, only when (a), (b) and (c) pass and each one
// is a built-in command (in `slash_commands`): sdk.d.ts documents that with
// bundled skills off, "built-in slash commands stay typable but are hidden
// from the model". Anything else, or anything that cannot be read, fails.
// Saver profile, the real `briefstack web` in a temp home (tasks-common.ts).
// Run:  npx tsx scripts/real/check-task-skills.ts --yes

import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import {
  controlSession,
  discard,
  driveRound,
  newTap,
  sampleProject,
  sessionEvents,
  sleep,
  startTask,
  startWeb,
  usageGate,
  type ContextSkills,
  type EventSeen,
  type Tap,
  type ToolCall,
} from './tasks-common.js';

requireConfirmation('Phase 7 real check 5: a task session gets only the project skills (saver profile, one control session and one short task session), in a temp home.');

const SKILL = 'sample-skill';
const FOREIGN = 'doctor';
/** Bundled skills the model may invoke without the task's layers, in order of preference (the first one only reads). */
const INVOCABLE = ['claude-api', 'simplify'];
const LATE = 'late-skill';
/** What the task guard says when it refuses a skill (src/tasks/guard.ts), from the callback or the command hook. */
const GUARD_REFUSAL = /Only the project's own skills can be used in a task|briefstack task guard/;

const names = (context: ContextSkills | null | string | undefined): string[] | undefined =>
  typeof context === 'object' && context !== null ? context.skillFrontmatter.map((skill) => skill.name).sort() : undefined;
const describe = (context: ContextSkills | null | string | undefined): string =>
  typeof context === 'object' && context !== null
    ? `${context.includedSkills} of ${context.totalSkills} included, ${context.tokens} tokens: ${context.skillFrontmatter.map((skill) => `${skill.name} (${skill.source}, ${skill.tokens})`).join(', ') || 'none'}`
    : String(context ?? 'no reading');

interface Attempt {
  label: string;
  skill: string;
  calls: ToolCall[];
  /** One line per call: what came back and which layer refused it. */
  lines: string[];
  ran: boolean;
  ambiguous: boolean;
}

/** What happened to the session's `Skill` calls to `skill`: refused (by which layer), ran, or no result. */
function attempt(label: string, skill: string, calls: ToolCall[], tap: Tap, events: EventSeen[]): Attempt {
  const mine = calls.filter((call) => call.input.skill === skill || call.input.skill === `/${skill}`);
  const lines: string[] = [];
  let ran = false;
  let ambiguous = false;
  for (const call of mine) {
    const result = tap.results.get(call.id);
    const pre = events.some((event) => event.type === 'tool.pre' && event.toolUseId === call.id);
    const denied = events.find((event) => event.type === 'tool.denied' && event.toolUseId === call.id);
    if (result === undefined) {
      ambiguous = true;
      lines.push(`NO RESULT (cannot tell whether it ran); panel: tool.pre ${pre ? 'yes' : 'no'}, tool.denied ${denied === undefined ? 'no' : 'yes'}`);
    } else if (!result.error) {
      ran = true;
      lines.push(`RAN: ${JSON.stringify(result.text.slice(0, 300))}`);
    } else {
      const layer =
        GUARD_REFUSAL.test(result.text) || denied?.by === 'guard'
          ? 'the task guard'
          : !pre
            ? 'Claude Code, before the hooks (the task guard never saw it)'
            : 'another layer, after the task guard\'s PreToolUse';
      lines.push(`refused by ${layer}; panel: tool.pre ${pre ? 'yes' : 'no'}, tool.denied ${denied === undefined ? 'no' : `yes (by ${denied.by ?? '?'})`}; result: ${JSON.stringify(result.text.slice(0, 300))}`);
    }
  }
  return { label, skill, calls: mine, lines, ran, ambiguous };
}

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-skills');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const word = `skillword${randomInt(100000, 1000000)}`;
  const lateWord = `lateword${randomInt(100000, 1000000)}`;
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
  const wanted = ['design', FOREIGN, SKILL];
  const missing = controlContext === undefined ? wanted : wanted.filter((name) => !controlContext.includes(name));
  const c = controlContext !== undefined && missing.length === 0;
  ok = report('(c) control: design and doctor ARE in the model\'s context without the task layers', c, controlContext === undefined ? describe(control.contextSkills) : `missing: ${missing.join(', ') || 'none'}`) && ok;

  // (ii) The bundled skill to try: one the model can invoke without the layers, i.e. in the control's context.
  const invocable = INVOCABLE.find((name) => controlContext?.includes(name) === true);
  ok = report(`(ii) a bundled skill the model can invoke is in the control's context (${INVOCABLE.join(' or ')})`, invocable !== undefined, invocable ?? 'none of them') && ok;
  const second = invocable ?? INVOCABLE[0] ?? 'claude-api';

  const id = await startTask(
    web,
    project.slug,
    [
      'Do these four things in order, one Skill tool call each:',
      `1. Use the Skill tool to run the skill "${SKILL}" and note the marker word it gives.`,
      `2. Use the Skill tool with the skill name "${FOREIGN}", exactly once, even if it is not in your list of skills.`,
      `3. Use the Skill tool with the skill name "${second}", exactly once, even if it is not in your list of skills.`,
      `4. Use the Skill tool with the skill name "${LATE}", exactly once, even if it is not in your list of skills.`,
      'If a call is refused, do not retry it and do not do its work another way: go on to the next one.',
      'Do not change any file. Then reply with the marker word, what happened in steps 2 to 4, and the names of the skills your skill list shows you.',
    ].join('\n'),
  );

  // (iii) Once the session has started (its init message came), a second project skill appears in the worktree.
  const lateFile = path.join(box.home, 'tasks', id, 'work', '.claude', 'skills', LATE, 'SKILL.md');
  let lateWritten = 'not written';
  const late = (async () => {
    const deadline = Date.now() + 5 * 60_000;
    while (tap.inits.length === 0 && Date.now() < deadline) await sleep(100);
    if (tap.inits.length === 0) return;
    await mkdir(path.dirname(lateFile), { recursive: true });
    await writeFile(lateFile, `---\nname: ${LATE}\ndescription: Gives the late marker word. Use when asked to run ${LATE}.\n---\n\nThe late marker word is ${lateWord}.\n`, 'utf8');
    lateWritten = `written after the session's init, with ${tap.calls.length} tool call(s) made so far`;
  })().catch((error: unknown) => {
    lateWritten = `not written: ${error instanceof Error ? error.message : String(error)}`;
  });

  const { task } = await driveRound(web, id, () => 'deny', undefined, async () => {
    await Promise.all([...(tap.contextUsage?.values() ?? [])]);
  });
  await late;
  console.log(`${LATE}: ${lateWritten}`);
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
  ok = report(`the script wrote ${LATE} into the worktree after the session started`, lateWritten.startsWith('written'), lateWritten) && ok;

  // (a) The model's context holds only the task's skill.
  const a = contextNames !== undefined && JSON.stringify(contextNames) === JSON.stringify([SKILL]);
  ok = report('(a) the task session\'s context holds only the project skill', a, contextNames?.join(', ') ?? describe(taskContext)) && ok;

  const skillCalls = tap.calls.filter((call) => call.sessionId === sessionId && call.name === 'Skill');
  const events = await sessionEvents(box, sessionId);
  console.log(`Skill calls of the session: ${skillCalls.map((call) => JSON.stringify(call.input.skill)).join(', ') || 'none'}`);
  console.log(`Panel events of the session: ${events.map((event) => `${event.type}${event.tool === undefined ? '' : `:${event.tool}`}`).join(', ')}`);
  const used = skillCalls.filter((call) => call.input.skill === SKILL && tap.results.get(call.id)?.error === false);
  ok = report('control: the task session used the project skill', used.length >= 1, skillCalls.map((call) => String(call.input.skill)).join(', ') || 'no Skill call') && ok;

  // (b) Each call to a skill not on the task's list is refused by some layer and does not run.
  const attempts = [attempt('(i)', FOREIGN, skillCalls, tap, events), attempt('(ii)', second, skillCalls, tap, events), attempt('(iii)', LATE, skillCalls, tap, events)];
  const summary = task.rounds[0]?.summary ?? '';
  const lateSeen = summary.includes(lateWord) || [...tap.results.values()].some((result) => result.text.includes(lateWord));
  let b = true;
  for (const one of attempts) {
    for (const line of one.lines) console.log(`   ${one.label} Skill "${one.skill}": ${line}`);
    const passed = one.calls.length >= 1 && !one.ran && !one.ambiguous && (one.skill !== LATE || !lateSeen);
    const detail = one.calls.length === 0 ? 'NO CALL: nothing measured' : one.ran ? 'IT RAN' : one.ambiguous ? 'NO RESULT: ambiguous' : one.skill === LATE && lateSeen ? 'the late marker word came back' : `${one.calls.length} call(s), all refused`;
    b = report(`(b) ${one.label} the Skill call to ${one.skill} was refused by some layer and did not run`, passed, detail) && b;
  }
  if (attempts.some((one) => one.ran) || lateSeen) console.log('SECURITY FAILURE: a skill that is not on the task\'s list ran.');
  ok = b && ok;

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
  console.log(`Round: ${task.state}; summary ${JSON.stringify(summary.slice(0, 900))}`);

  await discard(web, id);
  await web.stop();
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

// Real check (PLAN-phase-7 M9, 4): a project whose own settings allow every
// shell command must still ask. The sample project commits a
// `.claude/settings.json` (and a `.claude/settings.local.json`) with allow
// rules for every Bash and PowerShell command; the task runs
// `shellScenario` (tasks-common.ts): the dialog for command A appears and is
// denied, A does not run; command B, the control, asks too and runs once
// allowed. Also expected: the task hid both settings files in its worktree
// (the control that the files were there to be read and were not).
// Saver profile, the real `briefstack web` in a temp home (tasks-common.ts).
// The settings hold allow rules only; no permission mode is set in them.
// Not controlled, and said in the output: that the allow rules would work
// without the task's layers (by H0 they are not used in an SDK session, so
// no control session can show it), and anything about the local settings
// file beyond its hiding.
// Run:  npx tsx scripts/real/check-task-allow-all.ts --yes

import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { git, newTap, sampleProject, shellScenario, startWeb, usageGate } from './tasks-common.js';

requireConfirmation('Phase 7 real check 4: project settings that allow every shell command must still ask (saver profile, one short task session), in a temp home.');

const ALLOW_ALL = `${JSON.stringify({ permissions: { allow: ['Bash', 'Bash(*)', 'PowerShell', 'PowerShell(*)'] } }, null, 2)}\n`;

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-allow-all');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const tap = newTap();
  const web = await startWeb(check, box, tap);
  const project = await sampleProject(box, 'sample-allow-all', { '.claude/settings.json': ALLOW_ALL, '.claude/settings.local.json': ALLOW_ALL });
  const committed = await git(project.dir, ['show', `${project.base}:.claude/settings.json`], project.emptyHooks);
  ok = report('control: the project commits settings that allow every shell command', committed === ALLOW_ALL, committed.replace(/\s+/g, ' ')) && ok;
  const result = await shellScenario(web, box, tap, project);
  ok = result.ok && ok;
  const hidden = [...result.task.hidden].sort();
  ok = report('control: the task hid both settings files in its worktree', JSON.stringify(hidden) === JSON.stringify(['.claude/settings.json', '.claude/settings.local.json']), JSON.stringify(hidden)) && ok;
  console.log(
    'NOT CONTROLLED: that the allow rules would let a shell command run without the task layers. By H0, permissions.allow of a project\'s settings is not used in an SDK session of an untrusted folder, so a control session could not show it (decisions.md, "Phase 7: H0" and "Phase 7: M9 real checks").',
  );
  console.log(
    'NOT CONTROLLED: .claude/settings.local.json. No control session reads it here (settingSources [\'project\'] does not); for it, only the task hiding it is shown.',
  );
  await web.stop();
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

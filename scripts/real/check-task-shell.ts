// Real check (PLAN-phase-7 M9, 2): a task that needs a shell command. The
// dialog appears with the exact command; denied, the command does not run
// (`shellScenario` in tasks-common.ts, with a second command allowed once as
// the control). A sample project with no settings file, the saver profile, the
// real `briefstack web` in a temp home (tasks-common.ts).
// Run:  npx tsx scripts/real/check-task-shell.ts --yes

import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { newTap, sampleProject, shellScenario, startWeb, usageGate } from './tasks-common.js';

requireConfirmation('Phase 7 real check 2: a task that needs shell commands (saver profile, one short task session), in a temp home.');

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-shell');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const tap = newTap();
  const web = await startWeb(check, box, tap);
  const project = await sampleProject(box, 'sample-shell', {});
  const result = await shellScenario(web, box, tap, project);
  ok = result.ok && ok;
  ok = report('the project has no settings file to hide (plain project)', result.task.hidden.length === 0, JSON.stringify(result.task.hidden)) && ok;
  await web.stop();
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

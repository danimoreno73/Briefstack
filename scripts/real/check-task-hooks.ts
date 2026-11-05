// Real check (PLAN-phase-7 M9, 3): a project's hooks never run in a task.
//
// The sample project commits `.claude/settings.json` and
// `.claude/settings.local.json`, each with command hooks on SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, Stop and SessionEnd. Every hook
// is the same small Node script (outside the project) that writes a marker
// file named after its label and event into a markers folder.
// Controls, so the check cannot pass on nothing:
//   1. the hook script, run by hand, writes its marker (then it is removed);
//   2. a control session WITHOUT briefstack's task layers (a plain SDK
//      session in the project folder with its settings) makes a tool call:
//      the project's hooks must run there and write markers (then removed);
//   3. the task's session makes tool calls, reads and a write among them,
//      so PreToolUse and PostToolUse would have fired.
// Expected: after the task's round, and after it is discarded (its session
// closed), the markers folder is empty.
// Not controlled, and said in the output: the hooks of
// `.claude/settings.local.json` running without the task's layers (the
// control session's settingSources ['project'] does not read that file);
// for it only the hiding in the worktree is shown.
// Saver profile, the real `briefstack web` in a temp home (tasks-common.ts).
// Run:  npx tsx scripts/real/check-task-hooks.ts --yes

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { controlSession, discard, driveRound, newTap, sampleProject, sleep, startTask, startWeb, usageGate } from './tasks-common.js';

requireConfirmation('Phase 7 real check 3: a project hook must not run in a task (saver profile, one control session and one short task session), in a temp home.');

const HOOK_SCRIPT = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  'const [dir, label] = process.argv.slice(2);',
  'let input = {};',
  "try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}",
  "const event = String(input.hook_event_name ?? 'manual').replace(/[^A-Za-z]/g, '');",
  "writeFileSync(path.join(dir, `${label}-${event}-${Date.now()}.txt`), 'ran\\n');",
  '',
].join('\n');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];

const markers = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).sort();
const clear = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
};

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-hooks');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const markersDir = path.join(box.dir, 'hook-markers');
  await mkdir(markersDir, { recursive: true });
  const script = path.join(box.dir, 'hook-mark.mjs');
  await writeFile(script, HOOK_SCRIPT, 'utf8');
  const settingsWith = (label: string) =>
    `${JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command: process.execPath, args: [script, markersDir, label], timeout: 30 }] }]])) }, null, 2)}\n`;

  // Control 1: the script writes its marker.
  execFileSync(process.execPath, [script, markersDir, 'manual'], { input: '{}', windowsHide: true });
  const manual = await markers(markersDir);
  ok = report('control: the hook script writes a marker when run', manual.length === 1, manual.join(', ') || 'none') && ok;
  await clear(markersDir);

  const tap = newTap();
  const web = await startWeb(check, box, tap);
  const project = await sampleProject(box, 'sample-hooks', { '.claude/settings.json': settingsWith('settings'), '.claude/settings.local.json': settingsWith('local') });

  // Control 2: without the task's layers the project's hooks run.
  const control = await controlSession(check, box, executable, {
    cwd: project.dir,
    tools: ['Glob'],
    allowTools: ['Glob'],
    prompt: 'Use the Glob tool once with the pattern "*.md", then reply with the single word OK.',
  });
  await sleep(3000);
  const controlMarkers = await markers(markersDir);
  console.log(`Control session: tool calls ${control.calls.map((call) => call.name).join(', ') || 'none'}; markers ${controlMarkers.join(', ') || 'none'}`);
  ok = report('control: the project hooks run in a session without the task layers', controlMarkers.some((name) => name.startsWith('settings-') || name.startsWith('local-')), `${controlMarkers.length} marker(s)`) && ok;
  ok = report('control: the project folder is still clean after the control session', execFileSync('git', ['status', '--porcelain'], { cwd: project.dir, encoding: 'utf8' }).trim() === '', '') && ok;
  console.log(
    "NOT CONTROLLED: .claude/settings.local.json. The control session loads settingSources ['project'], which does not read the local file, so this check does not show that its hooks would run without the task layers; for it, only the task hiding it is shown (decisions.md, \"Phase 7: M9 real checks\").",
  );
  await clear(markersDir);

  const id = await startTask(web, project.slug, 'Use Glob once to list the *.md files, read README.md, then add one line "Checked." at the end of README.md. Change nothing else.');
  const { task } = await driveRound(web, id, () => 'deny');
  ok = report('the round ended on the proposal', task.state === 'proposal', `${task.state}${task.error === undefined ? '' : `: ${task.error}`}`) && ok;
  const sessionId = task.rounds[0]?.sessionId;
  const calls = tap.calls.filter((call) => call.sessionId === sessionId);
  console.log(`Task session tool calls: ${calls.map((call) => call.name).join(', ') || 'none'}`);
  ok = report('control: the task session made tool calls, a write among them', calls.length >= 2 && calls.some((call) => call.name === 'Edit' || call.name === 'Write'), `${calls.length} call(s)`) && ok;
  ok = report('control: the task hid both settings files', JSON.stringify([...task.hidden].sort()) === JSON.stringify(['.claude/settings.json', '.claude/settings.local.json']), JSON.stringify(task.hidden)) && ok;
  const afterRound = await markers(markersDir);
  ok = report('no project hook ran during the task round', afterRound.length === 0, afterRound.join(', ') || 'no marker') && ok;

  await discard(web, id);
  await web.stop();
  await sleep(3000);
  const atEnd = await markers(markersDir);
  ok = report('no project hook ran up to the end (session closed, server stopped)', atEnd.length === 0, atEnd.join(', ') || 'no marker') && ok;
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

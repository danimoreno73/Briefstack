// Real check (PLAN-phase-7 M9, 1): a small task end to end, through the real
// `briefstack web` and a real task session on the saver profile, in a temp
// home with a sample project (tasks-common.ts).
//
// The task: add one line with a random marker word at the end of README.md.
// Two declared checks, set and confirmed as the project page does:
//   c1  passes only when README.md holds the marker (so it reads the task's
//       tree, not the project's);
//   c2  appends a line to a log file in the work folder (so it shows
//       whether, and how often, the checks ran).
// Expected:
//   - the round ends on the proposal; the session made tool calls (the tap
//     and the panel's events), among them a write to README.md;
//   - the diff holds README.md only, with the marker line;
//   - the checks have not run by themselves: no results, no log line;
//     nothing reached the project folder;
//   - run from the proposal's action with the list the page shows, both
//     pass, and the log has exactly one line;
//   - approve: one commit on `main` whose parent is the base and whose tree
//     is the reviewed commit's; the folder is clean; the branch and the
//     worktree are gone; no remote, so nothing could be pushed; a dated
//     line in the note;
//   - revert: one revert commit whose tree is the base's; a dated line.
// Run:  npx tsx scripts/real/check-task-flow.ts --yes

import { randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { claudeExecutable, report, requireConfirmation, sandbox, startCheck } from './common.js';
import { driveRound, exists, getTask, git, newTap, sampleProject, sessionEventTypes, slashed, sleep, startTask, startWeb, usageGate, waitState } from './tasks-common.js';

requireConfirmation('Phase 7 real check 1: a small task end to end (saver profile, one short task session), in a temp home.');

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('task-flow');
  check.add(() => box.cleanup());
  await usageGate(box, executable, 'before');
  const tap = newTap();
  const web = await startWeb(check, box, tap);
  const project = await sampleProject(box, 'sample-flow', {});
  const g = (args: string[]) => git(project.dir, args, project.emptyHooks).then((out) => out.trim());

  const marker = `taskmark${randomInt(100000, 1000000)}`;
  const checksLog = path.join(box.dir, 'checks-ran.log');
  const commands = [
    `node -e "process.exitCode=require('fs').readFileSync('README.md','utf8').includes('${marker}')?0:4"`,
    `node -e "require('fs').appendFileSync('${slashed(checksLog)}','ran\\n')"`,
  ];
  const set = await web.call('PUT', `/api/projects/${project.slug}/checks`, { commands, confirm: true });
  ok = report('the checks were set and confirmed (as the project page does)', set.status === 200, `${set.status} ${set.body.slice(0, 200)}`) && ok;

  const description = `Add one line at the very end of README.md with exactly this text: Task marker: ${marker}\nChange nothing else and create no other file.`;
  const id = await startTask(web, project.slug, description);
  const started = await getTask(web, id);
  console.log(`Profile ${started.profile}, model ${started.model}, effort ${started.effort}; base ${started.baseBranch} ${started.baseCommit.slice(0, 10)}`);
  ok = report('the task uses the saver profile', started.profile === 'saver', `${started.profile} ${started.model} ${started.effort}`) && ok;

  const { task, approvals } = await driveRound(web, id, () => 'deny');
  ok = report('the round ended on the proposal', task.state === 'proposal', `${task.state}${task.error === undefined ? '' : `: ${task.error}`}`) && ok;
  const sessionId = task.rounds[0]?.sessionId;
  const calls = tap.calls.filter((call) => call.sessionId === sessionId);
  console.log(`Tool calls of the session: ${calls.map((call) => call.name).join(', ') || 'none'}; dialogs: ${approvals.length}`);
  const wroteReadme = calls.some((call) => (call.name === 'Edit' || call.name === 'Write') && String(call.input.file_path ?? '').replaceAll('\\', '/').endsWith('/README.md'));
  ok = report('control: the session made tool calls, a write to README.md among them', wroteReadme, `${calls.length} call(s)`) && ok;
  const events = await sessionEventTypes(box, sessionId);
  ok = report('control: the panel has the session and its tool calls', events.includes('session.started') && events.some((type) => type.startsWith('tool.pre')), `${events.length} event line(s)`) && ok;

  const proposal = await web.call('GET', `/api/tasks/${id}/proposal`);
  const shown = proposal.json() as { diff: { files: { path: string; status: string; added: number; removed: number; hunks: { lines: { op: string; text: string }[] }[] }[] } | null; checkCommands?: string[] };
  const files = shown.diff?.files ?? [];
  console.log(`Diff: ${files.map((file) => `${file.path} (${file.status}, +${file.added} -${file.removed})`).join(', ') || 'empty'}`);
  for (const file of files) for (const hunk of file.hunks) for (const line of hunk.lines) if (line.op !== ' ') console.log(`   ${line.op} ${line.text}`);
  const added = files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.op === '+').map((line) => line.text)));
  ok = report('the diff holds README.md only', files.length === 1 && files[0]?.path === 'README.md', files.map((file) => file.path).join(', ') || 'empty') && ok;
  ok = report('the diff adds the marker line', added.some((line) => line.includes(marker)), added.join(' | ')) && ok;

  ok = report('the checks did not run by themselves: no results', task.checks === undefined, JSON.stringify(task.checks ?? null)) && ok;
  ok = report('the checks did not run by themselves: no log line', !(await exists(checksLog)), checksLog) && ok;
  ok = report('the page lists the confirmed checks', JSON.stringify(shown.checkCommands) === JSON.stringify(commands), JSON.stringify(shown.checkCommands)) && ok;
  ok = report('nothing reached the project folder yet', (await g(['rev-parse', 'HEAD'])) === project.base && !(await readFile(path.join(project.dir, 'README.md'), 'utf8')).includes(marker), '') && ok;

  const run = await web.call('POST', `/api/tasks/${id}/checks`, { commands: shown.checkCommands, confirm: true });
  ok = report('the proposal action started the checks', run.status === 202, `${run.status}`) && ok;
  const checked = await waitState(web, id, ['proposal', 'failed']);
  const results = checked.checks ?? [];
  for (const result of results) console.log(`   check ${JSON.stringify(result.command)}: exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''} ${JSON.stringify(result.output.slice(-200))}`);
  ok = report('both checks ran and passed (c1 read the task\'s README)', results.length === 2 && results.every((result) => result.exitCode === 0), results.map((result) => result.exitCode).join(', ')) && ok;
  const logLines = (await readFile(checksLog, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
  ok = report('the checks ran exactly once', logLines.length === 1, `${logLines.length} line(s)`) && ok;

  const reviewed = checked.reviewed ?? '';
  const reviewedTree = await g(['rev-parse', `${reviewed}^{tree}`]);
  const baseTree = await g(['rev-parse', `${project.base}^{tree}`]);
  const approve = await web.call('POST', `/api/tasks/${id}/approve`, { confirm: true });
  ok = report('approve answered', approve.status === 200, `${approve.status} ${approve.body.slice(0, 200)}`) && ok;
  const applied = await waitState(web, id, ['applied', 'failed']);
  const head = await g(['rev-parse', 'HEAD']);
  console.log(`Applied: ${applied.state}, commit ${applied.applied?.commit ?? '-'}; HEAD ${head}`);
  console.log(`   ${await g(['log', '--format=%h %s', '-3'])}`.replaceAll('\n', '\n   '));
  ok = report('one commit on main, on top of the base', applied.state === 'applied' && (await g(['rev-parse', 'HEAD^'])) === project.base && (await g(['rev-parse', '--abbrev-ref', 'HEAD'])) === 'main', head) && ok;
  ok = report('its tree is the reviewed commit\'s', (await g(['rev-parse', 'HEAD^{tree}'])) === reviewedTree, reviewedTree) && ok;
  ok = report('the project folder is clean and has the line', (await g(['status', '--porcelain'])) === '' && (await readFile(path.join(project.dir, 'README.md'), 'utf8')).includes(marker), '') && ok;
  ok = report('the task branch is gone', (await g(['branch', '--list', `briefstack/task-${id}`])) === '', '') && ok;
  ok = report('the worktree is gone', !(await stat(path.join(box.home, 'tasks', id, 'work')).then(() => true, () => false)), '') && ok;
  ok = report('no remote: nothing could be pushed', (await g(['remote'])) === '', (await g(['remote'])) || 'none') && ok;

  const revert = await web.call('POST', `/api/tasks/${id}/revert`, { confirm: true });
  ok = report('revert answered', revert.status === 200, `${revert.status} ${revert.body.slice(0, 200)}`) && ok;
  const reverted = await waitState(web, id, ['reverted', 'applied', 'failed']);
  console.log(`Reverted: ${reverted.state}, commit ${reverted.reverted?.commit ?? '-'}`);
  console.log(`   ${await g(['log', '--format=%h %s', '-3'])}`.replaceAll('\n', '\n   '));
  ok = report('one revert commit on top of the applied one', reverted.state === 'reverted' && (await g(['rev-parse', 'HEAD^'])) === head, '') && ok;
  ok = report('the tree is the base\'s again', (await g(['rev-parse', 'HEAD^{tree}'])) === baseTree && (await g(['diff', project.base, 'HEAD'])) === '', baseTree) && ok;
  ok = report('the project folder is clean', (await g(['status', '--porcelain'])) === '', '') && ok;

  const noteFile = path.join(box.home, 'library', 'projects', `${project.slug}.md`);
  let note = '';
  for (let i = 0; i < 30 && !(note.includes('Task applied:') && note.includes('Task reverted:')); i += 1) {
    note = await readFile(noteFile, 'utf8');
    if (!(note.includes('Task applied:') && note.includes('Task reverted:'))) await sleep(1000);
  }
  ok = report('the note has the applied and reverted lines', note.includes('Task applied:') && note.includes('Task reverted:'), note.split('\n').filter((line) => line.includes('Task ')).join(' | ')) && ok;

  await web.stop();
  await usageGate(box, executable, 'after').catch((error: unknown) => console.log(String(error)));
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

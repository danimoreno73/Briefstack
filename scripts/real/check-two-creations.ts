// Real check (BRIEF-phase-4 §5): two cheap real creations at the same time.
//
// Runs two real creations side by side through the same manager and runner
// `briefstack web` uses, in a temp BRIEFSTACK_HOME (its own library, projects
// and sessions folders); the real library and projects are not touched. The
// skill runs from the briefstack repo, as in the web app.
//
// Profile: saver. The agent files in `.claude/agents/` must already hold the
// saver models (this script never rewrites them): if they do not, it stops and
// says to run `npm run briefstack -- usage set saver` first (and
// `usage set <your profile>` afterwards to go back).
//
// This script plays the browser for both (`autoAnswer` in common.ts): every
// question gets its first (recommended) option, except that a folder is only
// ever chosen inside the temp projects folder (no such option: the creation
// is cancelled); the spec is approved when its summary names no folder
// outside it; a folder grant is accepted only inside it; permission requests
// are refused; and a turn that ends with nothing asked gets the reply
// "Go on with the recommended options.". Expected:
//   1. both creations end `completed`;
//   2. both projects are in the temp projects folder, in different folders;
//   3. the temp library has both project notes and a clean git tree (the
//      library queue kept the two commits apart);
//   4. both sessions ran at the same time (overlapping start and end).
// It spends two short creations on the saver profile (Sonnet session, mostly
// Haiku agents). It stops after 40 minutes. Plan usage is printed before and
// after; above 70% of the 5-hour window it does not start.
// Run:  npx tsx scripts/real/check-two-creations.ts --yes

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { updateConfig } from '../../src/config/index.js';
import { createWebCreations } from '../../src/creation/wiring.js';
import type { CreationState } from '../../src/creation/manager.js';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { listProjects } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { agentSetting, loadUsageProfiles, baseProfilesFile } from '../../src/usage/index.js';
import {
  CheckStop,
  autoAnswer,
  claudeExecutable,
  readPlanUsage,
  report,
  requireConfirmation,
  sandbox,
  sandboxLibrary,
  show,
  startCheck,
} from './common.js';

requireConfirmation('Run two short real creations at the same time on the saver profile, in a temp home.');

const IDEAS = [
  'A one-page checklist for packing a carry-on bag for a weekend trip. Keep it minimal.',
  'A tiny template for weekly reading notes: title, one quote, one thought. Keep it minimal.',
];
const LIMIT_MS = 40 * 60_000;

// The agent files must already hold the saver models: this script never rewrites them.
const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile() });
const saver = profiles.presets.saver;
if (saver === undefined) throw new Error('no saver preset');
const mismatched: string[] = [];
for (const agent of ['interviewer', 'researcher', 'architect', 'generator', 'reviewer']) {
  const file = path.join(PACKAGE_ROOT, '.claude', 'agents', `${agent}.md`);
  const { data } = parseFrontmatter(await readFile(file, 'utf8'), file);
  if (data.model !== agentSetting(saver, agent)?.model) mismatched.push(`${agent}: ${String(data.model)}`);
}
if (mismatched.length > 0) {
  console.error(`The agent files do not hold the saver profile (${mismatched.join(', ')}).`);
  console.error('Run  npm run briefstack -- usage set saver  first, and  usage set <your profile>  afterwards.');
  process.exit(2);
}

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('two-creations');
  check.add(() => box.cleanup());
  const before = await readPlanUsage(box, executable);
  console.log(`Plan usage before: ${show(before)}`);
  if (typeof before !== 'string' && (before.fiveHour ?? 0) > 70) {
    throw new CheckStop(2, 'The 5-hour window is above 70%: not starting.');
  }
  const pathEnv = await sandboxLibrary(box);
  await updateConfig(path.join(box.home, 'config.json'), { activeProfile: 'saver', permissionPolicy: 'ask' });
  const manager = await createWebCreations({ pathEnv, repoDir: PACKAGE_ROOT, lang: 'en' });
  check.add(() => manager.shutdown());

  const started = await Promise.all(IDEAS.map((idea) => manager.create(idea)));
  const ids = started.map((state) => state.id);
  console.log(`Started ${ids.join(', ')}`);
  const deadline = Date.now() + LIMIT_MS;
  const answered = new Set<string>();
  const states = (): CreationState[] => ids.map((id) => manager.get(id));
  while (states().some((state) => state.status !== 'finished') && Date.now() < deadline) {
    // Each state is read just before acting on it: a snapshot taken before an await on the other creation may be stale.
    for (const id of ids) {
      const state = manager.get(id);
      if (state.status === 'finished') continue;
      const pending = state.pending;
      if (pending !== undefined && !answered.has(`${state.id}:${pending.id}`)) {
        answered.add(`${state.id}:${pending.id}`);
        const summary = pending.kind === 'spec' ? await manager.readSpec(state.id).then((view) => view.summary, () => null) : undefined;
        const decision = autoAnswer(pending, box.projects, { summary });
        if (decision.kind === 'cancel') {
          console.log(`${state.id.slice(0, 8)} ${pending.kind} → cancel: ${decision.reason.slice(0, 160)}`);
          manager.cancel(state.id);
          continue;
        }
        console.log(`${state.id.slice(0, 8)} ${pending.kind} → ${JSON.stringify(decision.answer).slice(0, 120)}`);
        manager.answer(state.id, pending.id, decision.answer);
      } else if (pending === undefined && state.awaitingReply !== undefined && !answered.has(`${state.id}:reply:${state.awaitingReply.at}`)) {
        answered.add(`${state.id}:reply:${state.awaitingReply.at}`);
        console.log(`${state.id.slice(0, 8)} reply`);
        manager.reply(state.id, 'Go on with the recommended options.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (states().some((state) => state.status !== 'finished')) {
    console.log('Time is up: cancelling what is left.');
    for (const id of ids) manager.cancel(id);
  }
  await manager.shutdown();

  const final = states();
  for (const state of final) console.log(`${state.id.slice(0, 8)}: ${state.outcome ?? state.status} (${state.startedAt} → ${state.finishedAt ?? '?'})`);
  ok = report('both completed', final.every((state) => state.outcome === 'completed'), final.map((state) => state.outcome).join(', ')) && ok;
  const projects = await listProjects(path.join(box.home, 'library'));
  const folders = projects.filter((project) => project.slug !== 'seed-tracker').map((project) => project.status?.path ?? '');
  ok = report('two project notes, in two different folders', folders.length === 2 && new Set(folders).size === 2, folders.join(' | ') || 'none') && ok;
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: path.join(box.home, 'library'), encoding: 'utf8' }).trim();
  ok = report('the temp library git tree is clean', status === '', status || 'clean') && ok;
  const [a, b] = final;
  const overlap = a !== undefined && b !== undefined && a.startedAt < (b.finishedAt ?? '') && b.startedAt < (a.finishedAt ?? '');
  ok = report('they ran at the same time', overlap, '') && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

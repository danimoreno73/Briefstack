// Real check (BRIEF-phase-6 §5): fetch and review one real public skill from
// GitHub, without a token, into a temp library; approve it; install it into a
// temp claude-code project; validate that project.
//
// It contacts api.github.com (about four requests of the 60 per hour allowed
// without a token) and raw.githubusercontent.com, and runs one very short
// Haiku session for the model review (no tools, no settings). Everything is
// in a sandbox (a temp BRIEFSTACK_HOME, library and projects folder); the
// real library and projects are not touched. Plan usage is printed before
// and after; above 70% of the 5-hour window or 95% of the week it does not
// start.
//
// Run:  npx tsx scripts/real/check-skill-fetch.ts --yes [--url <github link>]
// Default link: anthropics/skills, skills/brand-guidelines, branch main.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { scaffold } from '../../src/scaffold/index.js';
import { installSkills } from '../../src/skills/install.js';
import { SdkSkillReviewer } from '../../src/skills/modelReview.js';
import { SkillService } from '../../src/skills/service.js';
import { parseSpec } from '../../src/spec/index.js';
import { baseProfilesFile, loadUsageProfiles } from '../../src/usage/profiles.js';
import { validateProject } from '../../src/validate/index.js';
import { CheckStop, claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sandboxLibrary, show, startCheck } from './common.js';

requireConfirmation('Fetch one real public skill from GitHub and run one very short Haiku review of it, in a temp home.');

const urlIndex = process.argv.indexOf('--url');
const URL = urlIndex >= 0 ? (process.argv[urlIndex + 1] ?? '') : 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines';

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('skill-fetch');
  check.add(() => box.cleanup());
  const before = await readPlanUsage(box, executable);
  console.log(`Plan usage before: ${show(before)}`);
  if (typeof before !== 'string' && ((before.fiveHour ?? 0) > 70 || (before.sevenDay ?? 0) > 95)) {
    throw new CheckStop(2, 'Plan usage is above 70% of the 5-hour window or 95% of the week: not starting.');
  }
  const pathEnv = await sandboxLibrary(box);
  const libraryDir = path.join(box.home, 'library');
  const skills = new SkillService({ libraryDir: async () => libraryDir, reviewer: new SdkSkillReviewer({ pathEnv }) });

  console.log(`Fetching ${URL}`);
  const started = Date.now();
  const added = await skills.add(URL, ['check']);
  const record = added.detail?.record;
  if (record === undefined) throw new Error('nothing was stored');
  console.log(`Stored ${record.name} in ${Math.round((Date.now() - started) / 1000)} s: ${record.files.length} files, commit ${record.source.commit}`);
  console.log(`License: ${record.license.spdx ?? record.license.source}; scripts: ${record.hasScripts}; network: ${record.network}`);
  console.log(`Findings: ${record.findings.map((f) => `${f.severity}/${f.rule}${f.file === '' ? '' : ` ${f.file}${f.line === undefined ? '' : `:${f.line}`}`}`).join(', ') || 'none'}`);
  console.log(`Model review: ${record.model.state}: ${record.model.reason}`);

  ok = report('stored in quarantine, pinned to a commit', record.status === 'quarantine' && /^[0-9a-f]{40}$/.test(record.source.commit), record.source.link) && ok;
  ok = report('SKILL.md is among the files, each with a SHA-256', record.files.some((f) => f.path === 'SKILL.md') && record.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), String(record.files.length)) && ok;
  ok = report('the model review answered', record.model.state !== 'unavailable', record.model.reason) && ok;
  ok = report('one library commit', added.committed, added.warnings.map((w) => w.code).join(', ') || 'committed') && ok;

  await skills.approve(record.name);
  const project = path.join(box.projects, 'skill-check');
  await scaffold(parseSpec({ specVersion: 1, name: 'Skill check', slug: 'skill-check', summary: 'Checks a library skill.', language: 'en', type: 'generic', target: 'claude-code', profile: 'saver', goal: 'Check.', audience: 'Me.', deliverables: ['A check'], doneWhen: ['It passes'], librarySkills: [{ name: record.name, reason: 'The check.' }] }, 'spec.json'), project, {
    protectedDirs: [],
    templateRoots: [path.join(PACKAGE_ROOT, 'library', 'templates')],
    profiles: await loadUsageProfiles({ baseFile: baseProfilesFile() }),
  });
  const installed = await installSkills({ projectDir: project, skills });
  ok = report('installed into the project', installed.installed.length === 1, installed.installed[0]?.location ?? 'nothing') && ok;
  const result = await validateProject(project, { pathEnv });
  const skillFindings = result.findings.filter((f) => f.rule.startsWith('librarySkill.'));
  ok = report('the validator finds the installed files intact', skillFindings.length === 0, skillFindings.map((f) => f.rule).join(', ') || 'intact') && ok;
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: libraryDir, encoding: 'utf8' }).trim();
  ok = report('the temp library git tree is clean', status === '', status || 'clean') && ok;

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

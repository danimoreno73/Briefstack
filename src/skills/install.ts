import { createHash } from 'node:crypto';
import { chmod, constants, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { inspectOutputDir, realpathNearest, type ProtectedDir } from '../scaffold/outputDir.js';
import { readSpec, type Target } from '../spec/index.js';
import { skillsMessages } from '../i18n/skills.js';
import type { SkillRecord } from './record.js';
import { assertPathsFit } from './pathLength.js';
import { filesMatch } from './service.js';
import { buildZip } from './zip.js';

/**
 * `briefstack skills install` (BRIEF-phase-6 §3.5): copies approved library
 * skills into a project, byte for byte, never over an existing file, and
 * records where each came from in `.briefstack/skills.json`. For
 * `claude-code` a skill goes to `.claude/skills/<name>/`; for `claude-app`
 * to `skills/<name>.zip` (the skill folder at the root of the archive) with
 * a line in `NEXT_STEPS.md` on how to add it in the app. The validator
 * checks the installed files against the recorded hashes.
 */

export const INSTALL_RECORD = '.briefstack/skills.json';
const SPEC_FILE = '.briefstack/spec.json';
const NEXT_STEPS = 'NEXT_STEPS.md';
/** The byte order mark some editors put at the start of a text file. */
const BOM = String.fromCharCode(0xfeff);

const installedFileSchema = z.object({
  path: z.string(),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  executable: z.boolean(),
});

export const installedSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  repo: z.string(),
  path: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  link: z.string(),
  license: z.string().nullable(),
  /** The spec agent it was chosen for; absent for the whole project. */
  agent: z.string().optional(),
  /** Relative path with `/`: `.claude/skills/<name>` or `skills/<name>.zip`. */
  location: z.string(),
  files: z.array(installedFileSchema),
  /** `claude-app`: the archive's own hash. */
  zipSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  installedAt: z.string(),
});
export type InstalledSkill = z.infer<typeof installedSkillSchema>;

const recordFileSchema = z.object({ v: z.literal(1), skills: z.array(installedSkillSchema) });

/** What install needs from the skill library: the approved files, checked against their hashes. */
export interface ApprovedSource {
  approvedFiles(name: string): Promise<{ record: SkillRecord; dir: string }>;
}

export interface InstallOptions {
  projectDir: string;
  skills: ApprovedSource;
  /** One skill to add (an existing project); without it, the spec's `librarySkills`. */
  only?: string | undefined;
  /** The project must not overlap these (the repo, the library, the home). */
  protectedDirs?: readonly ProtectedDir[];
  now?: () => Date;
}

export interface InstallResult {
  projectDir: string;
  target: Target;
  installed: InstalledSkill[];
  /** Skills of the spec that were installed before. */
  already: string[];
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The installed skills a project records; empty when it has none. Throws on a broken record. */
export async function readInstalled(projectDir: string): Promise<InstalledSkill[]> {
  let text: string;
  try {
    text = await readFile(path.join(projectDir, ...INSTALL_RECORD.split('/')), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const parsed = recordFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.skills;
  } catch {
    // Reported below.
  }
  throw new BriefstackError('skills.installRecordInvalid', { file: INSTALL_RECORD });
}

async function writeInstalled(projectDir: string, skills: readonly InstalledSkill[]): Promise<void> {
  const file = path.join(projectDir, ...INSTALL_RECORD.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ v: 1, skills }, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** `target` (which may not exist yet) is inside `root` once symlinks are followed. */
async function staysInside(target: string, root: string): Promise<boolean> {
  return isPathInside(await realpathNearest(target), await realpathNearest(root), systemPathEnv());
}

/** The "Skills" section of `NEXT_STEPS.md`: the steps once, then one line per archive. */
export function nextStepsWithSkill(text: string, line: string, lang: 'en' | 'es'): string {
  const m = skillsMessages[lang];
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${m.nextStepsHeading}`);
  if (start === -1) return `${lines.join('\n')}\n\n## ${m.nextStepsHeading}\n\n${m.nextStepsIntro}\n\n${line}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, line);
  return `${lines.join('\n')}\n`;
}

/**
 * Adds a library skill to an existing project's spec, by the user's own
 * choice (the chat's confirmed card), so `skills install --skill` may
 * install it. Returns how to put the spec back if the install then fails.
 */
export async function chooseInSpec(projectDir: string, name: string, now: Date = new Date()): Promise<() => Promise<void>> {
  const file = path.join(path.resolve(projectDir), ...SPEC_FILE.split('/'));
  if (!(await exists(file))) throw new BriefstackError('skills.notAProject', { dir: path.resolve(projectDir) });
  const spec = await readSpec(file);
  const before = await readFile(file, 'utf8');
  const restore = async () => {
    await writeFile(file, before, 'utf8');
  };
  if (spec.librarySkills.some((skill) => skill.name === name)) return async () => undefined;
  const data = JSON.parse(before.startsWith(BOM) ? before.slice(1) : before) as Record<string, unknown>;
  const list = Array.isArray(data.librarySkills) ? (data.librarySkills as unknown[]) : [];
  const lang = spec.language.toLowerCase().startsWith('es') ? 'es' : 'en';
  list.push({ name, reason: skillsMessages[lang].addedReason(now.toISOString().slice(0, 10)) });
  data.librarySkills = list;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return restore;
}

/** The project folder exists and overlaps none of `protectedDirs`; returns it resolved. */
export async function checkProjectDir(projectDir: string, protectedDirs: readonly ProtectedDir[] | undefined): Promise<string> {
  const root = path.resolve(projectDir);
  let info;
  try {
    info = await stat(root);
  } catch {
    info = undefined;
  }
  if (info === undefined || !info.isDirectory()) throw new BriefstackError('skills.projectNotFound', { dir: root });
  if (protectedDirs !== undefined) {
    const report = await inspectOutputDir(root, protectedDirs);
    if (report.status === 'forbidden' && report.overlaps !== undefined) {
      throw new BriefstackError('scaffold.forbiddenOutput', { outDir: root, root: report.overlaps.root, rootPath: report.overlaps.path });
    }
  }
  return root;
}

export async function installSkills(options: InstallOptions): Promise<InstallResult> {
  const now = options.now ?? (() => new Date());
  const root = await checkProjectDir(options.projectDir, options.protectedDirs);
  const specPath = path.join(root, ...SPEC_FILE.split('/'));
  if (!(await exists(specPath))) throw new BriefstackError('skills.notAProject', { dir: root });
  const spec = await readSpec(specPath);
  const installed = await readInstalled(root);
  const has = (name: string) => installed.some((entry) => entry.name === name);

  let wanted: { name: string; agent?: string | undefined }[];
  const already: string[] = [];
  if (options.only !== undefined) {
    if (has(options.only)) throw new BriefstackError('skills.alreadyInstalled', { name: options.only });
    if (spec.skills.some((skill) => skill.name.toLowerCase() === options.only?.toLowerCase())) {
      throw new BriefstackError('skills.wouldOverwrite', { path: `.claude/skills/${options.only}` });
    }
    // Only a skill the approved spec chose: one the user unticked never comes back this way.
    const chosen = spec.librarySkills.find((skill) => skill.name === options.only);
    if (chosen === undefined) throw new BriefstackError('skills.notInSpec', { name: options.only });
    wanted = [{ name: chosen.name, agent: chosen.agent }];
  } else {
    wanted = [];
    for (const skill of spec.librarySkills) {
      if (has(skill.name)) already.push(skill.name);
      else wanted.push({ name: skill.name, agent: skill.agent });
    }
  }

  const lang = spec.language.toLowerCase().startsWith('es') ? 'es' : 'en';
  const result: InstallResult = { projectDir: root, target: spec.target, installed: [], already };
  for (const want of wanted) {
    const { record, dir } = await options.skills.approvedFiles(want.name);
    const base: Omit<InstalledSkill, 'location' | 'zipSha256'> = {
      name: record.name,
      description: record.description,
      repo: record.source.repo,
      path: record.source.path,
      commit: record.source.commit,
      link: record.source.link,
      license: record.license.spdx,
      ...(want.agent === undefined ? {} : { agent: want.agent }),
      files: record.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable })),
      installedAt: now().toISOString(),
    };
    let entry: InstalledSkill;
    if (spec.target === 'claude-code') {
      const location = `.claude/skills/${record.name}`;
      const target = path.join(root, ...location.split('/'));
      if (await exists(target)) throw new BriefstackError('skills.wouldOverwrite', { path: location });
      if (!(await staysInside(target, root))) throw new BriefstackError('skills.wouldOverwrite', { path: location });
      assertPathsFit(target, record.files);
      try {
        for (const file of record.files) {
          const to = path.join(target, ...file.path.split('/'));
          await mkdir(path.dirname(to), { recursive: true });
          await copyFile(path.join(dir, ...file.path.split('/')), to, constants.COPYFILE_EXCL);
          if (file.executable && process.platform !== 'win32') await chmod(to, 0o755);
        }
        const match = await filesMatch(target, record.files);
        if (!match.ok) throw new BriefstackError('skills.modified', { name: record.name, path: match.path });
      } catch (error) {
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        throw error;
      }
      entry = { ...base, location };
    } else {
      const location = `skills/${record.name}.zip`;
      const target = path.join(root, ...location.split('/'));
      if (await exists(target)) throw new BriefstackError('skills.wouldOverwrite', { path: location });
      if (!(await staysInside(target, root))) throw new BriefstackError('skills.wouldOverwrite', { path: location });
      const entries = [];
      for (const file of record.files) {
        const bytes = await readFile(path.join(dir, ...file.path.split('/')));
        if (sha256(bytes) !== file.sha256) throw new BriefstackError('skills.modified', { name: record.name, path: file.path });
        entries.push({ path: `${record.name}/${file.path}`, bytes, executable: file.executable });
      }
      const zip = buildZip(entries);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, zip, { flag: 'wx' });
      entry = { ...base, location, zipSha256: sha256(zip) };
      const nextSteps = path.join(root, NEXT_STEPS);
      const current = (await exists(nextSteps)) ? await readFile(nextSteps, 'utf8') : `# ${skillsMessages[lang].nextStepsTitle}\n`;
      await writeFile(nextSteps, nextStepsWithSkill(current, skillsMessages[lang].nextStepsLine(location, record.name, record.description), lang), 'utf8');
    }
    installed.push(entry);
    await writeInstalled(root, installed);
    result.installed.push(entry);
  }
  return result;
}

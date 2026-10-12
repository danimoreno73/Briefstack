import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { BriefstackError } from '../errors.js';
import type { Spec } from '../spec/index.js';
import { applyProfileToProject } from '../usage/apply.js';
import { getPreset, type UsageProfiles } from '../usage/profiles.js';
import { checkOutputDir, existingPaths, type ProtectedDir } from './outputDir.js';
import { buildPlan } from './plan.js';
import { loadTemplate } from './templates.js';

export { buildPlan, templateVars, type ProjectProfile, type ScaffoldPlan } from './plan.js';
export { DENY_RULES, SECRET_ENV_FILES, isReadDenied, readRuleDenies } from './secrets.js';
export {
  checkOutputDir,
  inspectOutputDir,
  realpathNearest,
  type OutputDirReport,
  type OutputDirStatus,
  type ProtectedDir,
} from './outputDir.js';
export { loadTemplate, renderTemplate, type Template, type TemplateFile } from './templates.js';

const execFileAsync = promisify(execFile);

export interface ScaffoldOptions {
  /** Folders the project must not overlap: the briefstack repo and the library. */
  protectedDirs: readonly ProtectedDir[];
  /** Template roots in priority order: personal library first, then base. */
  templateRoots: readonly string[];
  /** Usage presets; the spec's `profile` must be one of them. */
  profiles: UsageProfiles;
  allowNonEmpty?: boolean;
  /** Set to false to skip `git init` (tests). */
  gitInit?: boolean;
}

export type ScaffoldWarning = { code: 'gitUnavailable' } | { code: 'gitFailed'; detail: string };

export interface ScaffoldResult {
  outDir: string;
  template: string;
  templateDir: string;
  /** Usage profile applied to the generated agents. */
  profile: string;
  /** Created files, relative with `/`. */
  files: string[];
  directories: string[];
  gitInitialised: boolean;
  warnings: ScaffoldWarning[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function gitInit(outDir: string): Promise<{ ok: boolean; warning?: ScaffoldWarning }> {
  if (await exists(path.join(outDir, '.git'))) return { ok: true };
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: outDir });
    return { ok: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, warning: { code: 'gitUnavailable' } };
    }
    const detail = (error as { stderr?: string }).stderr?.trim() || String(error);
    return { ok: false, warning: { code: 'gitFailed', detail } };
  }
}

/**
 * Creates the project folder from a validated spec. All checks run before
 * anything is written; existing files are never overwritten.
 */
export async function scaffold(
  spec: Spec,
  outDir: string,
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  // Fails with usage.unknownProfile before anything is written.
  getPreset(options.profiles, spec.profile);
  const state = await checkOutputDir(outDir, options.protectedDirs, options.allowNonEmpty ?? false);
  const templateName = spec.template ?? spec.type;
  const template = await loadTemplate(templateName, spec.target, options.templateRoots);
  const plan = buildPlan(spec, template);

  if (state.existed) {
    const clashes = await existingPaths(
      state.outDir,
      plan.files.map((file) => file.path),
    );
    if (clashes.length > 0) {
      throw new BriefstackError('scaffold.wouldOverwrite', { outDir: state.outDir, paths: clashes });
    }
  }

  const toNative = (relative: string) => path.join(state.outDir, ...relative.split('/'));
  await mkdir(state.outDir, { recursive: true });
  for (const directory of plan.directories) {
    await mkdir(toNative(directory), { recursive: true });
  }
  for (const file of plan.files) {
    const target = toNative(file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' });
  }

  // Sets each generated agent's model and effort from its tier.
  await applyProfileToProject(state.outDir, spec.profile, options.profiles);

  const warnings: ScaffoldWarning[] = [];
  let gitInitialised = false;
  if (options.gitInit ?? true) {
    const git = await gitInit(state.outDir);
    gitInitialised = git.ok;
    if (git.warning !== undefined) warnings.push(git.warning);
  }

  return {
    outDir: state.outDir,
    template: templateName,
    templateDir: template.dir,
    profile: spec.profile,
    files: plan.files.map((file) => file.path),
    directories: plan.directories,
    gitInitialised,
    warnings,
  };
}

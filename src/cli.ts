#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configFilePath, readConfig, resolvePaths, updateConfig } from './config/config.js';
import { systemPathEnv, type PathEnv } from './config/paths.js';
import { isBriefstackError } from './errors.js';
import { cliMessages } from './i18n/cli.js';
import { formatError } from './i18n/errors.js';
import { initSummary, libraryMessages, renderLibraryContext } from './i18n/library.js';
import { resolveLang, systemLocale, type Lang } from './i18n/index.js';
import { scaffoldMessages } from './i18n/scaffold.js';
import { usageMessages } from './i18n/usage.js';
import { formatFinding, validateMessages } from './i18n/validate.js';
import { VERSION } from './index.js';
import {
  INDEX_FILE,
  LOG_INDEX_FILE,
  addNote,
  buildLibraryContext,
  initLibrary,
  libraryExists,
  listNotes,
  noteLink,
  readNote,
} from './library/index.js';
import { PACKAGE_ROOT } from './packageRoot.js';
import { scaffold } from './scaffold/index.js';
import { readSpec } from './spec/index.js';
import {
  agentSetting,
  applyProfileToAgents,
  applyProfileToProject,
  baseProfilesFile,
  checkAgentDrift,
  getPreset,
  loadUsageProfiles,
  resolveActiveProfile,
  usageEnvWarnings,
  type ApplyResult,
} from './usage/index.js';
import { validateProject } from './validate/index.js';

/** Argument parsing only; all real work lives in the library. */

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  pathEnv: PathEnv;
  /**
   * Folder whose `.claude/agents/` `usage set` rewrites and `usage show`
   * checks for drift, and whose `.claude/settings.local.json` `init`
   * updates. Defaults to the briefstack package (the repo).
   */
  repoDir?: string;
}

const defaultIO = (): CliIO => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  cwd: process.cwd(),
  pathEnv: systemPathEnv(),
});

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  /** Options that take a value: `--name value` or `--name=value`. */
  values: Map<string, string>;
}

function parseArgs(
  args: readonly string[],
  allowedFlags: readonly string[],
  lang: Lang,
  valueOptions: readonly string[] = [],
  usage = '',
): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (valueOptions.includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '' || values.has(name)) {
        throw new UsageError(cliMessages[lang].wrongArguments(usage));
      }
      values.set(name, value);
    } else if (allowedFlags.includes(arg)) {
      flags.add(arg);
    } else {
      throw new UsageError(cliMessages[lang].unknownOption(arg));
    }
  }
  return { positionals, flags, values };
}

async function runScaffold(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = scaffoldMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--allow-non-empty'], lang);
  const [specArg, outArg] = positionals;
  if (positionals.length !== 2 || specArg === undefined || outArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }

  const { paths, profiles } = await loadProfiles(io);
  const spec = await readSpec(path.resolve(io.cwd, specArg));
  const result = await scaffold(spec, path.resolve(io.cwd, outArg), {
    protectedDirs: [
      { root: 'repo', path: PACKAGE_ROOT },
      { root: 'library', path: paths.libraryDir },
    ],
    templateRoots: [
      path.join(paths.libraryDir, 'templates'),
      path.join(PACKAGE_ROOT, 'library', 'templates'),
    ],
    profiles,
    allowNonEmpty: flags.has('--allow-non-empty'),
  });

  io.out(messages.created(result.outDir, result.files.length, result.template));
  io.out(messages.profileApplied(result.profile));
  if (result.gitInitialised) io.out(messages.gitInitialised);
  for (const warning of result.warnings) io.err(messages.warning(warning));
  return EXIT_OK;
}

async function loadProfiles(io: CliIO) {
  const config = await readConfig(configFilePath(io.pathEnv));
  const paths = resolvePaths(config, io.pathEnv);
  const profiles = await loadUsageProfiles({
    baseFile: baseProfilesFile(),
    userFile: paths.userProfilesFile,
  });
  return { config, paths, profiles };
}

const repoAgentsDir = (io: CliIO): string => path.join(io.repoDir ?? PACKAGE_ROOT, '.claude', 'agents');

async function runUsageShow(io: CliIO, lang: Lang): Promise<number> {
  const messages = usageMessages[lang];
  const { config, profiles } = await loadProfiles(io);
  const active = resolveActiveProfile(config, profiles);
  const { preset } = active;

  io.out(messages.activeProfile(active.name, preset.label[lang]));
  if (!active.fromConfig) io.out(messages.defaultProfileNote);
  io.out(messages.sessionModel(preset.sessionModel));
  io.out(messages.agentsHeader);
  for (const agent of Object.keys(preset.agents)) {
    const setting = agentSetting(preset, agent);
    if (setting !== undefined) io.out(messages.agentLine(agent, setting.model, setting.effort));
  }
  io.out(messages.projectTiers(preset.tiers.light, preset.tiers.standard, preset.tiers.heavy));
  io.out(messages.research(preset.research));
  io.out(messages.reviewRounds(preset.reviewRounds));
  io.out(messages.available(Object.keys(profiles.presets)));

  const drift = await checkAgentDrift(repoAgentsDir(io));
  if (drift.status === 'checked' && drift.drift.length > 0) {
    io.err(messages.driftHeader);
    for (const item of drift.drift) io.err(messages.driftLine(item));
  }
  for (const warning of usageEnvWarnings(io.pathEnv.env)) io.err(messages.envWarning(warning));
  io.out(messages.consumption);
  return EXIT_OK;
}

function reportApply(result: ApplyResult, io: CliIO, lang: Lang): void {
  const messages = usageMessages[lang];
  io.out(result.changed.length > 0 ? messages.changedFiles(result.changed) : messages.noChanges);
  if (result.notInProfile.length > 0) io.out(messages.notInProfile(result.notInProfile));
}

async function runUsageSet(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = usageMessages[lang];
  const { positionals, values } = parseArgs(args, [], lang, ['--project'], messages.usage);
  const [name] = positionals;
  if (positionals.length !== 1 || name === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const { paths, profiles } = await loadProfiles(io);
  const preset = getPreset(profiles, name);

  const project = values.get('--project');
  if (project !== undefined) {
    const result = await applyProfileToProject(path.resolve(io.cwd, project), name, profiles);
    io.out(messages.projectApplied(result.projectDir, name, result.previousProfile));
    reportApply(result, io, lang);
    if (result.missingAgents.length > 0) io.err(messages.missingAgents(result.missingAgents));
    return EXIT_OK;
  }

  const result = await applyProfileToAgents(repoAgentsDir(io), preset);
  await updateConfig(paths.configFile, { activeProfile: name });
  io.out(messages.applied(name));
  reportApply(result, io, lang);
  io.out(messages.savedActive(name));
  io.out(messages.sessionModel(preset.sessionModel));
  if (result.changed.length > 0) io.out(messages.doNotCommit);
  return EXIT_OK;
}

async function runUsage(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'show' && rest.length === 0) return runUsageShow(io, lang);
  if (sub === 'set') return runUsageSet(rest, io, lang);
  throw new UsageError(cliMessages[lang].wrongArguments(usageMessages[lang].usage));
}

async function runValidate(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = validateMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--json'], lang);
  const [dirArg] = positionals;
  if (positionals.length !== 1 || dirArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }

  const result = await validateProject(path.resolve(io.cwd, dirArg), { pathEnv: io.pathEnv });
  if (flags.has('--json')) {
    const { projectDir, target, errors, warnings, findings } = result;
    io.out(JSON.stringify({ projectDir, target: target ?? null, errors, warnings, findings }, null, 2));
  } else if (result.findings.length === 0) {
    io.out(messages.clean(result.projectDir));
  } else {
    for (const item of result.findings) io.out(formatFinding(item, lang));
    io.out(messages.summary(result.projectDir, result.errors, result.warnings));
  }
  return result.errors > 0 ? EXIT_ERROR : EXIT_OK;
}

async function resolvedPaths(io: CliIO) {
  return resolvePaths(await readConfig(configFilePath(io.pathEnv)), io.pathEnv);
}

async function runInit(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = libraryMessages[lang];
  if (args.length > 0) throw new UsageError(cliMessages[lang].wrongArguments(messages.initUsage));
  const paths = await resolvedPaths(io);
  const result = await initLibrary({
    libraryDir: paths.libraryDir,
    projectsDir: paths.projectsDir,
    repoDir: io.repoDir ?? PACKAGE_ROOT,
    pathStyle: io.pathEnv,
  });
  for (const line of initSummary(result, lang)) io.out(line);
  for (const warning of result.warnings) io.err(messages.warning(warning));
  return EXIT_OK;
}

async function runLibraryAdd(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = libraryMessages[lang];
  const { positionals, values } = parseArgs(args, [], lang, ['--from'], messages.usage);
  const [section, name] = positionals;
  const from = values.get('--from');
  if (section === undefined || positionals.length > 2 || from === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const paths = await resolvedPaths(io);
  const result = await addNote({
    libraryDir: paths.libraryDir,
    section,
    name,
    fromFile: path.resolve(io.cwd, from),
  });
  const link = noteLink(result.section, result.name);
  io.out(result.action === 'created' ? messages.noteCreated(link, result.file) : messages.noteAppended(link, result.file));
  if (result.status !== undefined) {
    io.out(messages.statusLine(result.status.status, result.status.target, result.status.profile));
  }
  if (result.indexUpdated) io.out(messages.indexUpdated(result.section === 'log' ? LOG_INDEX_FILE : INDEX_FILE));
  if (result.committed) io.out(messages.committed);
  for (const warning of result.warnings) io.err(messages.warning(warning));
  return EXIT_OK;
}

async function runLibraryList(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = libraryMessages[lang];
  const { positionals } = parseArgs(args, [], lang);
  if (positionals.length > 1) throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  const paths = await resolvedPaths(io);
  const notes = await listNotes(paths.libraryDir, positionals[0]);
  if (!(await libraryExists(paths.libraryDir))) io.out(messages.noLibrary(paths.libraryDir));
  else if (notes.length === 0) io.out(messages.listEmpty);
  for (const note of notes) io.out(messages.listLine(note));
  return EXIT_OK;
}

async function runLibraryShow(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = libraryMessages[lang];
  const { positionals } = parseArgs(args, [], lang);
  const [section, name] = positionals;
  if (section === undefined || positionals.length > 2) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const paths = await resolvedPaths(io);
  const note = await readNote(paths.libraryDir, section, name);
  io.out(note.text.replace(/\s+$/, ''));
  return EXIT_OK;
}

async function runLibraryContext(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = libraryMessages[lang];
  const { positionals, values } = parseArgs(args, [], lang, ['--idea', '--limit'], messages.usage);
  const idea = values.get('--idea');
  const limitText = values.get('--limit');
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (
    positionals.length > 0 ||
    idea === undefined ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
  ) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const paths = await resolvedPaths(io);
  const context = await buildLibraryContext({
    libraryDir: paths.libraryDir,
    ideaFile: path.resolve(io.cwd, idea),
    ...(limit !== undefined ? { limit } : {}),
  });
  io.out(renderLibraryContext(context, lang).replace(/\n$/, ''));
  return EXIT_OK;
}

async function runLibrary(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'add') return runLibraryAdd(rest, io, lang);
  if (sub === 'list') return runLibraryList(rest, io, lang);
  if (sub === 'show') return runLibraryShow(rest, io, lang);
  if (sub === 'context') return runLibraryContext(rest, io, lang);
  throw new UsageError(cliMessages[lang].wrongArguments(libraryMessages[lang].usage));
}

async function detectLang(io: CliIO): Promise<Lang> {
  let configLang: string | undefined;
  try {
    configLang = (await readConfig(configFilePath(io.pathEnv))).lang;
  } catch {
    // A broken config is reported by the command that needs it.
  }
  return resolveLang({ env: io.pathEnv.env, configLang, osLocale: systemLocale() });
}

export async function main(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  const lang = await detectLang(io);
  z.config(lang === 'es' ? z.locales.es() : z.locales.en());
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case '--version':
        io.out(`briefstack ${VERSION}`);
        return EXIT_OK;
      case undefined:
      case '--help':
        io.out(cliMessages[lang].usage);
        return EXIT_OK;
      case 'init':
        return await runInit(rest, io, lang);
      case 'library':
        return await runLibrary(rest, io, lang);
      case 'scaffold':
        return await runScaffold(rest, io, lang);
      case 'usage':
        return await runUsage(rest, io, lang);
      case 'validate':
        return await runValidate(rest, io, lang);
      default:
        throw new UsageError(cliMessages[lang].unknownCommand(command));
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    if (isBriefstackError(error)) {
      io.err(formatError(error, lang));
      return EXIT_ERROR;
    }
    io.err(cliMessages[lang].unexpected(error instanceof Error ? error.message : String(error)));
    return EXIT_ERROR;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

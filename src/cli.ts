#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configFilePath, readConfig, resolvePaths, updateConfig } from './config/config.js';
import { isFullyAbsolute, systemPathEnv, type PathEnv } from './config/paths.js';
import { BriefstackError, isBriefstackError } from './errors.js';
import {
  SESSION_OUTCOMES,
  STEP_OUTCOMES,
  STEP_PHASES,
  appendEvent,
  flowEvent,
  isFlowStep,
  sessionLifecycleEvent,
  type FlowStep,
  type SessionOutcome,
  type SessionPhase,
  type StepOutcome,
  type StepPhase,
} from './events/index.js';
import { cliMessages } from './i18n/cli.js';
import { formatError } from './i18n/errors.js';
import { eventMessages } from './i18n/events.js';
import { initSummary, libraryMessages, renderLibraryContext } from './i18n/library.js';
import { pathsMessages } from './i18n/paths.js';
import { resolveLang, systemLocale, type Lang } from './i18n/index.js';
import { scaffoldMessages } from './i18n/scaffold.js';
import { specMessages } from './i18n/spec.js';
import { usageMessages } from './i18n/usage.js';
import { formatFinding, validateMessages } from './i18n/validate.js';
import { VERSION } from './version.js';
import {
  INDEX_FILE,
  LOG_INDEX_FILE,
  addNote,
  allowingDirectory,
  buildLibraryContext,
  initLibrary,
  libraryExists,
  listNotes,
  noteLink,
  readAdditionalDirectories,
  readNote,
} from './library/index.js';
import { PACKAGE_ROOT } from './packageRoot.js';
import { commitProject, inspectOutputDir, loadTemplate, scaffold, type ProtectedDir } from './scaffold/index.js';
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
import { DEFAULT_WEB_PORT, startWebServer } from './server/index.js';
import { webMessages } from './i18n/web.js';
import { checkClaudeCode, formatVersion, type ClaudeCheck } from './creation/claudeBinary.js';

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
  /**
   * Resolves when `web` should stop. Defaults to the first SIGINT or SIGTERM;
   * tests pass their own.
   */
  untilStopped?: () => Promise<void>;
  /** Built UI served by `web`; defaults to `dist/web` in the package. */
  uiDir?: string;
  /** Checks the installed Claude Code for `web`; tests pass their own. */
  checkClaude?: () => Promise<ClaudeCheck>;
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

  // Check every path argument before anything touches the disk.
  const specPath = argPath(io, lang, specArg);
  const outPath = argPath(io, lang, outArg);
  const { paths, profiles } = await loadProfiles(io);
  const spec = await readSpec(specPath);
  const result = await scaffold(spec, outPath, {
    protectedDirs: protectedDirs(paths.libraryDir),
    templateRoots: templateRoots(paths.libraryDir),

    profiles,
    allowNonEmpty: flags.has('--allow-non-empty'),
  });

  io.out(messages.created(result.outDir, result.files.length, result.template));
  if (result.files.some((file) => file.startsWith('.claude/agents/'))) {
    io.out(messages.profileApplied(result.profile));
  }
  if (result.gitInitialised) io.out(messages.gitInitialised);
  for (const warning of result.warnings) io.err(messages.warning(warning));
  return EXIT_OK;
}

/** Folders a generated project must not overlap. */
const protectedDirs = (libraryDir: string): ProtectedDir[] => [
  { root: 'repo', path: PACKAGE_ROOT },
  { root: 'library', path: libraryDir },
];

/** Where things live, and whether an output folder is usable. Reports; never fails on what it finds. */
async function runPaths(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = pathsMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--json'], lang, [], messages.usage);
  const json = flags.has('--json');
  const paths = await resolvedPaths(io);
  const repoDir = io.repoDir ?? PACKAGE_ROOT;
  const allowedDirs = await readAdditionalDirectories(repoDir);

  if (positionals.length === 0) {
    const libraryReady = await libraryExists(paths.libraryDir);
    if (json) {
      const { home, configFile, libraryDir, projectsDir, sessionsDir } = paths;
      const report = { home, configFile, libraryDir, libraryExists: libraryReady, projectsDir, sessionsDir, repoDir, allowedDirs };
      io.out(JSON.stringify(report, null, 2));
    } else {
      io.out(messages.home(paths.home));
      io.out(messages.library(paths.libraryDir, libraryReady));
      io.out(messages.projects(paths.projectsDir));
      io.out(messages.sessions(paths.sessionsDir));
      io.out(messages.allowedDirs(allowedDirs));
    }
    return EXIT_OK;
  }

  const [sub, dirArg] = positionals;
  if (sub !== 'check' || positionals.length !== 2 || dirArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const report = await inspectOutputDir(argPath(io, lang, dirArg), protectedDirs(paths.libraryDir));
  const allowedBy = allowingDirectory(report.outDir, allowedDirs, io.pathEnv) ?? null;
  if (json) {
    const overlaps = report.overlaps === undefined ? null : report.overlaps;
    io.out(JSON.stringify({ outDir: report.outDir, status: report.status, overlaps, allowed: allowedBy !== null, allowedBy }, null, 2));
    return EXIT_OK;
  }
  const { outDir, status } = report;
  if (status === 'forbidden') {
    const dir = report.overlaps as ProtectedDir;
    io.out(formatError(new BriefstackError('scaffold.forbiddenOutput', { outDir, root: dir.root, rootPath: dir.path }), lang));
    return EXIT_OK;
  }
  if (status === 'notADirectory') {
    io.out(formatError(new BriefstackError('scaffold.notADirectory', { outDir }), lang));
    return EXIT_OK;
  }
  io.out(messages[status](outDir));
  io.out(allowedBy === null ? messages.notAllowed(outDir) : messages.allowedBy(allowedBy));
  return EXIT_OK;
}

/** Checks a spec the way `scaffold` will, without writing anything. */
async function runSpec(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = specMessages[lang];
  const { positionals } = parseArgs(args, [], lang, [], messages.usage);
  const [sub, specArg] = positionals;
  if (sub !== 'check' || positionals.length !== 2 || specArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const specPath = argPath(io, lang, specArg);
  const { paths, profiles } = await loadProfiles(io);
  const spec = await readSpec(specPath);
  getPreset(profiles, spec.profile);
  const template = spec.template ?? spec.type;
  await loadTemplate(template, spec.target, templateRoots(paths.libraryDir));
  io.out(messages.valid(spec.name, spec.slug, template, spec.target, spec.profile));
  return EXIT_OK;
}

/** Personal templates first, then the base ones. */
const templateRoots = (libraryDir: string): string[] => [
  path.join(libraryDir, 'templates'),
  path.join(PACKAGE_ROOT, 'library', 'templates'),
];
/** Commits a prepared project, so the user starts from a clean tree. */
async function runCommit(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = scaffoldMessages[lang];
  const { positionals } = parseArgs(args, [], lang, [], messages.commitUsage);
  const [dirArg] = positionals;
  if (positionals.length !== 1 || dirArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.commitUsage));
  }
  const result = await commitProject(argPath(io, lang, dirArg));
  if (result.committed) io.out(messages.committed(result.projectDir));
  if (result.nothingToCommit) io.out(messages.nothingToCommit(result.projectDir));
  if (result.warning !== undefined) io.err(libraryMessages[lang].warning(result.warning));
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

async function runUsageShow(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = usageMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--json'], lang, [], messages.usage);
  if (positionals.length > 0) throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  const { config, profiles } = await loadProfiles(io);
  const active = resolveActiveProfile(config, profiles);
  const { preset } = active;

  if (flags.has('--json')) {
    // For /new-project: the knobs it follows and the warnings it relays.
    const drift = await checkAgentDrift(repoAgentsDir(io));
    const agents = Object.fromEntries(
      Object.keys(preset.agents).flatMap((agent) => {
        const setting = agentSetting(preset, agent);
        return setting === undefined ? [] : [[agent, setting]];
      }),
    );
    io.out(
      JSON.stringify(
        {
          profile: active.name,
          label: preset.label[lang],
          fromConfig: active.fromConfig,
          sessionModel: preset.sessionModel,
          agents,
          tiers: preset.tiers,
          research: preset.research,
          reviewRounds: preset.reviewRounds,
          available: Object.keys(profiles.presets),
          drift:
            drift.status === 'checked'
              ? drift.drift.map((item) => ({ ...item, committed: item.committed ?? null, current: item.current ?? null }))
              : [],
          envWarnings: usageEnvWarnings(io.pathEnv.env),
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

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
  const project = values.get('--project');
  const projectPath = project === undefined ? undefined : argPath(io, lang, project);
  const { paths, profiles } = await loadProfiles(io);
  const preset = getPreset(profiles, name);

  if (projectPath !== undefined) {
    const result = await applyProfileToProject(projectPath, name, profiles);
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
  if (sub === 'show') return runUsageShow(rest, io, lang);
  if (sub === 'set') return runUsageSet(rest, io, lang);
  throw new UsageError(cliMessages[lang].wrongArguments(usageMessages[lang].usage));
}

/**
 * Resolves a path argument against the cwd. On Windows a rooted path without
 * a drive (e.g. a Git Bash `/c/Users/...` passed unconverted) is refused:
 * it would resolve to `<current drive>:\c\Users\...` (decisions.md, H8).
 */
function argPath(io: CliIO, lang: Lang, value: string): string {
  const { pathApi } = io.pathEnv;
  if (pathApi.isAbsolute(value) && !isFullyAbsolute(value, pathApi)) {
    throw new UsageError(cliMessages[lang].drivelessPath(value));
  }
  return pathApi.resolve(io.cwd, value);
}

/** Records a flow step. Prints nothing on success, to keep the skill's transcript clean. */
async function runEvent(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = eventMessages[lang];
  const { positionals, values } = parseArgs(args, [], lang, ['--session', '--outcome'], messages.usage);
  const [step, phase] = positionals;
  const session = values.get('--session');
  if (positionals.length !== 2 || step === undefined || phase === undefined || session === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const isSession = step === 'session';
  if (!isSession && !isFlowStep(step)) throw new UsageError(messages.unknownStep(step));
  if (!(STEP_PHASES as readonly string[]).includes(phase)) throw new UsageError(messages.unknownPhase(phase));
  const outcome = values.get('--outcome');
  const outcomes: readonly string[] = isSession ? SESSION_OUTCOMES : STEP_OUTCOMES;
  if (outcome !== undefined && !outcomes.includes(outcome)) {
    throw new UsageError(messages.unknownOutcome(outcome, outcomes));
  }

  const config = await readConfig(configFilePath(io.pathEnv));
  const { sessionsDir } = resolvePaths(config, io.pathEnv);
  const event = isSession
    ? sessionLifecycleEvent(session, phase as SessionPhase, outcome as SessionOutcome | undefined)
    : flowEvent(session, step as FlowStep, phase as StepPhase, outcome as StepOutcome | undefined);
  await appendEvent(sessionsDir, event);
  return EXIT_OK;
}

async function runValidate(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = validateMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--json'], lang);
  const [dirArg] = positionals;
  if (positionals.length !== 1 || dirArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }

  const result = await validateProject(argPath(io, lang, dirArg), { pathEnv: io.pathEnv });
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
    sessionsDir: paths.sessionsDir,
    repoDir: io.repoDir ?? PACKAGE_ROOT,
    pathStyle: io.pathEnv,
  });
  for (const line of initSummary(result, lang)) io.out(line);
  for (const warning of result.warnings) io.err(messages.warning(warning));
  return EXIT_OK;
}

async function runLibraryAdd(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = libraryMessages[lang];
  const { positionals, values } = parseArgs(args, [], lang, ['--from', '--session'], messages.usage);
  const [section, name] = positionals;
  const from = values.get('--from');
  const session = values.get('--session');
  if (
    section === undefined ||
    positionals.length > 2 ||
    from === undefined ||
    (session !== undefined && section !== 'projects')
  ) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }
  const fromFile = argPath(io, lang, from);
  const paths = await resolvedPaths(io);
  const result = await addNote({ libraryDir: paths.libraryDir, section, name, fromFile, session });
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
  const ideaFile = argPath(io, lang, idea);
  const paths = await resolvedPaths(io);
  const context = await buildLibraryContext({
    libraryDir: paths.libraryDir,
    ideaFile,
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

const untilSignal = (): Promise<void> =>
  new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

function claudeWarning(check: ClaudeCheck, lang: Lang): string | undefined {
  const messages = webMessages[lang];
  switch (check.status) {
    case 'compatible':
      return undefined;
    case 'notFound':
      return messages.claudeNotFound;
    case 'unknownVersion':
      return messages.claudeUnknownVersion(check.executable);
    case 'older':
      return messages.claudeOlder(formatVersion(check.installed), formatVersion(check.expected));
    case 'untested':
      return messages.claudeUntested(formatVersion(check.installed), formatVersion(check.expected));
  }
}

async function runWeb(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = webMessages[lang];
  const { positionals, values } = parseArgs(args, [], lang, ['--port'], messages.usage);
  if (positionals.length > 0) throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  const portValue = values.get('--port');
  let port = DEFAULT_WEB_PORT;
  if (portValue !== undefined) {
    port = Number(portValue);
    if (!/^\d+$/.test(portValue) || port > 65535) throw new BriefstackError('web.invalidPort', { value: portValue });
  }
  const server = await startWebServer({ port, lang, log: io.err,...(io.uiDir === undefined ? {} : { uiDir: io.uiDir }) });
  io.out(messages.listening);
  // Alone on its own line, so it is easy to copy.
  io.out(server.url);
  const claude = await (io.checkClaude ?? (() =>
    checkClaudeCode({ env: io.pathEnv.env, platform: process.platform, homedir: io.pathEnv.homedir })))();
  const warning = claudeWarning(claude, lang);
  if (warning !== undefined) io.err(warning);
  await (io.untilStopped ?? untilSignal)();
  await server.close();
  io.out(messages.stopped);
  return EXIT_OK;
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
      case 'commit':
        return await runCommit(rest, io, lang);
      case 'event':
        return await runEvent(rest, io, lang);
      case 'init':
        return await runInit(rest, io, lang);
      case 'library':
        return await runLibrary(rest, io, lang);
      case 'paths':
        return await runPaths(rest, io, lang);
      case 'spec':
        return await runSpec(rest, io, lang);
      case 'scaffold':
        return await runScaffold(rest, io, lang);
      case 'usage':
        return await runUsage(rest, io, lang);
      case 'validate':
        return await runValidate(rest, io, lang);
      case 'web':
        return await runWeb(rest, io, lang);
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

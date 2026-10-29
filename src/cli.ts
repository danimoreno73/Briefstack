#!/usr/bin/env node
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configFilePath, readConfig, resolvePaths } from './config/config.js';
import { isFullyAbsolute, systemPathEnv, type PathEnv } from './config/paths.js';
import { BriefstackError, isBriefstackError } from './errors.js';
import {
  SESSION_OUTCOMES,
  STEP_OUTCOMES,
  STEP_PHASES,
  appendEvent,
  flowEvent,
  isFlowStep,
  isSessionId,
  sessionLifecycleEvent,
  type FlowStep,
  type SessionOutcome,
  type SessionPhase,
  type StepOutcome,
  type StepPhase,
} from './events/index.js';
import { recordSessionFolder } from './events/sessionFolder.js';
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
  readNote,
  sessionAllowedDirectories,
} from './library/index.js';
import { PACKAGE_ROOT } from './packageRoot.js';
import { commitProject, inspectOutputDir, loadTemplate, protectedDirs, scaffold, type ProtectedDir } from './scaffold/index.js';
import { readSpec } from './spec/index.js';
import { getPreset, loadUsageContext, usageSet, usageShow, type ApplyResult } from './usage/index.js';
import { validateProject } from './validate/index.js';
import { DEFAULT_WEB_PORT, startWebServer } from './server/index.js';
import { webMessages } from './i18n/web.js';
import { ClaudeStatusReader, keySourceLabel, realClaudeStatusDeps, type AuthMode, type ClaudeStatus } from './creation/claudeAccount.js';
import type { ClaudeCheck } from './creation/claudeBinary.js';
import type { ChatRunner } from './chat/types.js';
import type { CreationRunner } from './creation/types.js';
import { createWebChat } from './chat/wiring.js';
import type { ChatManager } from './chat/manager.js';
import type { TaskManager } from './tasks/manager.js';
import type { TaskRunner } from './tasks/runner.js';
import { createWebTasks } from './tasks/wiring.js';
import { createWebCreations } from './creation/wiring.js';
import { createWebImprovements } from './improve/wiring.js';
import type { ImprovementManager } from './improve/manager.js';
import type { ImprovementRunner } from './improve/types.js';
import type { SafetyReviewer } from './improve/safetyReview.js';
import type { Verifier } from './improve/verify.js';
import { killProcessTree } from './creation/processTree.js';
import { runsDirOf, sweepRuns } from './creation/runFiles.js';
import { stopTrigger, type StopEvents } from './stopTrigger.js';
import type { FetchOptions } from './skills/github.js';
import type { SkillModelReviewer } from './skills/modelReview.js';
import { createWebSkills } from './skills/wiring.js';
import { installSkills } from './skills/install.js';
import { SkillService } from './skills/service.js';
import { skillsMessages } from './i18n/skills.js';
import { planUsageReader } from './creation/planUsage.js';
import { UsageCheck, configThresholds, type PlanReading } from './usage/warning.js';

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
  /**
   * Where `web` listens for signals and for errors nothing caught (a crash
   * is handled as a stop). Defaults to `process`; tests pass an emitter.
   */
  processEvents?: StopEvents;
  /** Built UI served by `web`; defaults to `dist/web` in the package. */
  uiDir?: string;
  /** Checks the installed Claude Code for `web`; tests pass their own. */
  checkClaude?: () => Promise<ClaudeCheck>;
  /**
   * Asks the installed Claude Code how it signs in, for `web`. The real
   * question unless a test passes its own; a test that passes `checkClaude`
   * and not this gets `unknown`, so no test ever runs the real `claude`.
   */
  readAuthMode?: (executable: string) => Promise<AuthMode>;
  /** The runner `web` creates projects with: the real SDK runner unless a test passes the fake one. */
  creationRunner?: CreationRunner;
  /** The runner of the global chat: the real SDK one unless a test passes the fake one. */
  chatRunner?: ChatRunner;
  /** The runner of improvement sessions and the verifier of their rounds: the real ones unless a test passes fakes. */
  improveRunner?: ImprovementRunner;
  /** The runner of tasks in existing projects: the real SDK one unless a test passes the fake one. */
  taskRunner?: TaskRunner;
  improveVerifier?: Verifier;
  safetyReviewer?: SafetyReviewer;
  /** The model review of skills and the GitHub hosts: the real ones unless a test passes its own. */
  skillReviewer?: SkillModelReviewer;
  skillFetch?: FetchOptions;
  /** The plan reading behind the usage warning: the real one with the real runner unless a test passes its own. */
  planUsage?: () => Promise<PlanReading | undefined>;
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
    protectedDirs: protectedDirs(paths.libraryDir, PACKAGE_ROOT, io.pathEnv),
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

/** Where things live, and whether an output folder is usable. Reports; never fails on what it finds. */
async function runPaths(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = pathsMessages[lang];
  const { positionals, flags, values } = parseArgs(args, ['--json'], lang, ['--session'], messages.usage);
  const json = flags.has('--json');
  const session = values.get('--session');
  if (session !== undefined && positionals[0] !== 'check') throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  if (session !== undefined && !isSessionId(session)) throw new BriefstackError('events.invalidSession', { session });
  const paths = await resolvedPaths(io);
  const repoDir = io.repoDir ?? PACKAGE_ROOT;
  const allowedDirs = await sessionAllowedDirectories(repoDir, io.pathEnv);

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
  const report = await inspectOutputDir(argPath(io, lang, dirArg), protectedDirs(paths.libraryDir, repoDir, io.pathEnv));
  // The folder the flow chose, so the web server can treat it as taken while this session runs (backlog 2, B9).
  // Best effort: a record that cannot be written only leaves the folder unclaimed, as before.
  if (session !== undefined && report.status !== 'forbidden' && report.status !== 'notADirectory') {
    await recordSessionFolder(paths.sessionsDir, session, report.outDir).catch(() => undefined);
  }
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
  // Library skills must be approved now: an unknown or unapproved one is an issue like any other.
  if (spec.librarySkills.length > 0) {
    const approved = new Set((await new SkillService({ libraryDir: async () => paths.libraryDir }).approvedIndex().catch(() => [])).map((s) => s.name));
    const issues = spec.librarySkills.flatMap((skill, index) =>
      approved.has(skill.name) ? [] : [{ path: `librarySkills.${index}.name`, rule: 'librarySkill' as const, message: skill.name }],
    );
    if (issues.length > 0) throw new BriefstackError('spec.invalid', { file: specPath, issues });
  }
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

const loadProfiles = (io: CliIO) => loadUsageContext(io.pathEnv);

async function runUsageShow(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = usageMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--json'], lang, [], messages.usage);
  if (positionals.length > 0) throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  const shown = await usageShow({ pathEnv: io.pathEnv, repoDir: io.repoDir, lang });

  if (flags.has('--json')) {
    // For /new-project: the knobs it follows and the warnings it relays.
    io.out(JSON.stringify(shown, null, 2));
    return EXIT_OK;
  }

  io.out(messages.activeProfile(shown.profile, shown.label));
  if (!shown.fromConfig) io.out(messages.defaultProfileNote);
  io.out(messages.sessionModel(shown.sessionModel));
  io.out(messages.chatModel(shown.chat.model, shown.chat.effort));
  io.out(messages.workModel(shown.work.model, shown.work.effort));
  io.out(messages.agentsHeader);
  for (const [agent, setting] of Object.entries(shown.agents)) {
    io.out(messages.agentLine(agent, setting.model, setting.effort));
  }
  io.out(messages.projectTiers(shown.tiers.light, shown.tiers.standard, shown.tiers.heavy));
  io.out(messages.research(shown.research));
  io.out(messages.reviewRounds(shown.reviewRounds));
  io.out(messages.available(shown.available));

  if (shown.drift.length > 0) {
    io.err(messages.driftHeader);
    for (const item of shown.drift) {
      io.err(messages.driftLine({ ...item, committed: item.committed ?? undefined, current: item.current ?? undefined }));
    }
  }
  for (const warning of shown.envWarnings) io.err(messages.envWarning(warning));
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
  const set = await usageSet({ pathEnv: io.pathEnv, repoDir: io.repoDir, profile: name, project: projectPath });

  if (set.scope === 'project') {
    const { result } = set;
    io.out(messages.projectApplied(result.projectDir, name, result.previousProfile));
    reportApply(result, io, lang);
    if (result.missingAgents.length > 0) io.err(messages.missingAgents(result.missingAgents));
    return EXIT_OK;
  }

  io.out(messages.applied(name));
  reportApply(set.result, io, lang);
  io.out(messages.savedActive(name));
  io.out(messages.sessionModel(set.sessionModel));
  if (set.result.changed.length > 0) io.out(messages.doNotCommit);
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

  const projectDir = argPath(io, lang, dirArg);
  // Files of library skills the user has not approved must not be in the project's skills.
  const { libraryDir } = await resolvedPaths(io);
  const libraryHashes = (await libraryExists(libraryDir)) ? await new SkillService({ libraryDir: async () => libraryDir }).contentHashes() : undefined;
  const result = await validateProject(projectDir, { pathEnv: io.pathEnv, ...(libraryHashes === undefined ? {} : { libraryHashes }) });
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

/** `skills install <project-dir> [--skill <name>] [--json]`: approved library skills into a project. */
async function runSkills(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = skillsMessages[lang];
  const [sub, ...rest] = args;
  if (sub !== 'install') throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  const { positionals, flags, values } = parseArgs(rest, ['--json'], lang, ['--skill'], messages.usage);
  const [dirArg] = positionals;
  if (positionals.length !== 1 || dirArg === undefined) throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  const projectDir = argPath(io, lang, dirArg);
  const paths = await resolvedPaths(io);
  const result = await installSkills({
    projectDir,
    skills: new SkillService({ libraryDir: async () => paths.libraryDir }),
    only: values.get('--skill'),
    protectedDirs: protectedDirs(paths.libraryDir, PACKAGE_ROOT, io.pathEnv),
  });
  if (flags.has('--json')) {
    io.out(JSON.stringify({ projectDir: result.projectDir, target: result.target, installed: result.installed, already: result.already }, null, 2));
    return EXIT_OK;
  }
  for (const entry of result.installed) io.out(messages.installed(entry.name, entry.location, entry.commit));
  for (const name of result.already) io.out(messages.already(name));
  if (result.installed.length === 0 && result.already.length === 0) io.out(messages.nothing);
  return EXIT_OK;
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

/** What `web` prints about Claude Code at start: a warning on `err`, the sign-in mode on `out`. */
function claudeLines(status: ClaudeStatus, lang: Lang): { warnings: string[]; info: string[] } {
  const messages = webMessages[lang];
  const warnings: string[] = [];
  const info: string[] = [];
  const { install, mode } = status;
  if (install.status === 'notFound') return { warnings: [messages.claudeNotFound], info };
  if (install.status === 'unknownVersion') warnings.push(messages.claudeUnknownVersion);
  if (install.status === 'older') warnings.push(messages.claudeOlder(install.installed, install.expected));
  if (install.status === 'untested') warnings.push(messages.claudeUntested(install.installed, install.expected));
  if (mode.kind === 'signIn') info.push(messages.authSignIn(mode.plan));
  if (mode.kind === 'apiKey') info.push(messages.authApiKey(keySourceLabel(mode.source)));
  if (mode.kind === 'cloud') info.push(messages.authCloud(mode.provider));
  if (mode.kind === 'none') warnings.push(messages.authNone);
  if (mode.kind === 'unknown') warnings.push(messages.authUnknown);
  return { warnings, info };
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
  // Before anything is served: a server that died with creations running left run files behind.
  const paths = await resolvedPaths(io);
  const swept = await sweepRuns({ runsDir: runsDirOf(paths.home), sessionsDir: paths.sessionsDir, kill: (pid) => killProcessTree(pid) });
  for (const entry of swept) {
    if (entry.action === 'killed') io.err(messages.sweptKilled(entry.pid ?? 0));
    if (entry.action === 'unverified') io.err(messages.sweptUnverified(entry.pid ?? 0));
    if (entry.action === 'live') io.err(messages.sweptLive(entry.pid ?? 0));
    if (entry.closedSession !== undefined) io.err(messages.sweptClosed(entry.closedSession));
  }
  const skills = createWebSkills({ pathEnv: io.pathEnv, reviewer: io.skillReviewer, fetch: io.skillFetch });
  // The real plan reading only with the real runner; tests pass their own or none.
  const planReading = io.planUsage ?? (io.creationRunner === undefined ? planUsageReader({ pathEnv: io.pathEnv, repoDir: io.repoDir ?? PACKAGE_ROOT }) : undefined);
  const usageCheck = planReading === undefined ? undefined : new UsageCheck({ read: planReading, thresholds: configThresholds(io.pathEnv) });
  // The user's Claude Code: the real readings unless a test passes its own; never the real `claude` in a test.
  const realDeps = realClaudeStatusDeps({ pathEnv: io.pathEnv, repoDir: io.repoDir ?? PACKAGE_ROOT });
  const claudeStatus = new ClaudeStatusReader({
    check: io.checkClaude ?? realDeps.check,
    mode: io.readAuthMode ?? (io.checkClaude === undefined ? realDeps.mode : async (): Promise<AuthMode> => ({ kind: 'unknown' })),
  });
  let tasks: TaskManager | undefined;
  const creations = await createWebCreations({
    pathEnv: io.pathEnv,
    repoDir: io.repoDir,
    lang,
    runner: io.creationRunner,
    skills,
    // Tasks share the active-sessions limit (BRIEF-phase-7 §2.6).
    otherActive: () => tasks?.activeIds() ?? [],
  });
  let chat: ChatManager | undefined;
  let improvements: ImprovementManager | undefined;
  let server;
  try {
    tasks = await createWebTasks({ pathEnv: io.pathEnv, repoDir: io.repoDir, lang, runner: io.taskRunner, creations });
    // A server that died with a task running left it interrupted; its worktree stays for the user.
    await tasks.recover();
    chat = await createWebChat({ pathEnv: io.pathEnv, repoDir: io.repoDir, lang, creations, runner: io.chatRunner, improvements: () => improvements, skills, usageCheck, tasks: () => tasks });
    improvements = await createWebImprovements({
      pathEnv: io.pathEnv,
      repoDir: io.repoDir,
      creations,
      runner: io.improveRunner,
      verifier: io.improveVerifier,
      safetyReviewer: io.safetyReviewer,
      announce: (suggestions) => chat?.announceSuggestions(suggestions),
    });
    server = await startWebServer({
      port,
      lang,
      log: io.err,
      pathEnv: io.pathEnv,
      creations,
      chat,
      improvements,
      skills,
      tasks,
      claudeStatus: (refresh) => claudeStatus.get(refresh),
      ...(usageCheck === undefined ? {} : { usageCheck }),
      ...(io.repoDir === undefined ? {} : { repoDir: io.repoDir }),
      ...(io.uiDir === undefined ? {} : { uiDir: io.uiDir }),
    });
  } catch (error) {
    await improvements?.shutdown();
    await chat?.shutdown();
    await tasks?.shutdown();
    await creations.shutdown();
    throw error;
  }
  io.out(messages.listening);
  // Alone on its own line, so it is easy to copy.
  io.out(server.url);
  const lines = claudeLines(await claudeStatus.get(), lang);
  for (const line of lines.info) io.out(line);
  for (const line of lines.warnings) io.err(line);
  // A crash stops it like Ctrl+C does: the shutdown below ends every creation's process tree.
  // Tests that pass `untilStopped` and no emitter never hear the test runner's own process events.
  const events: StopEvents = io.processEvents ?? (io.untilStopped === undefined ? process : new EventEmitter());
  const trigger = stopTrigger(
    events,
    (error) => io.err(messages.crashed(error instanceof Error ? (error.stack ?? error.message) : String(error))),
    io.untilStopped === undefined,
  );
  const { crashed } = await (io.untilStopped === undefined
    ? trigger.stopped
    : Promise.race([io.untilStopped().then(() => ({ crashed: false })), trigger.stopped]));
  try {
    // The chat and the creations first: a running creation is closed as interrupted before the server goes.
    await improvements.shutdown();
    await chat.shutdown();
    await tasks.shutdown();
    await creations.shutdown();
    await server.close();
  } finally {
    trigger.release();
  }
  io.out(messages.stopped);
  return crashed ? EXIT_ERROR : EXIT_OK;
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
      case 'skills':
        return await runSkills(rest, io, lang);
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

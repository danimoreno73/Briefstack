import type { StartIssue } from './builds/commands.js';
import type { SpecIssue } from './spec/index.js';

/** What a config field should have been; rendered by the i18n catalogue. */
export type FieldExpectation = 'text' | 'lang' | 'permissionPolicy' | 'positiveInteger' | 'percent' | 'boolean' | 'codexMode' | 'codexMaxCalls' | 'implementMinutes' | 'implementToolCalls';

/** Folders an output directory must stay out of. */
export type ProtectedRoot = 'repo' | 'library' | 'home' | 'claudeConfig' | 'appData' | 'localAppData';

/** The part of `settings.local.json` that has the wrong shape. */
export type SettingsField = 'root' | 'permissions' | 'additionalDirectories';

/**
 * Errors raised by the library. They carry a code and parameters, never
 * user-facing text: callers turn them into messages with `formatError`.
 */
export interface ErrorParams {
  'config.invalidJson': { file: string; detail: string };
  'config.notAnObject': { file: string };
  'config.invalidField': { file: string; field: string; expected: FieldExpectation };
  'config.relativePath': { source: string; value: string };
  'paths.overlapping': { from: string; to: string };
  'paths.targetMissing': { dir: string };
  'paths.homeNotMoved': { home: string; from: string };
  'frontmatter.unclosed': { file: string };
  'frontmatter.invalidYaml': { file: string; detail: string };
  'frontmatter.notAMapping': { file: string };
  'frontmatter.blockValue': { file: string; field: string };
  'spec.notFound': { file: string };
  'spec.invalidJson': { file: string; detail: string };
  'spec.invalid': { file: string; issues: SpecIssue[] };
  'scaffold.forbiddenOutput': { outDir: string; root: ProtectedRoot; rootPath: string };
  'scaffold.notADirectory': { outDir: string };
  'scaffold.nonEmptyOutput': { outDir: string };
  'scaffold.wouldOverwrite': { outDir: string; paths: string[] };
  'scaffold.templateNotFound': { template: string; searched: string[] };
  'scaffold.templateReservedPath': { template: string; path: string };
  'usage.profilesNotFound': { file: string };
  'usage.invalidProfiles': { file: string; issues: string[] };
  'usage.unknownProfile': { profile: string; available: string[] };
  /** A preset of that name exists already, base or user (step 33). */
  'usage.presetExists': { name: string };
  'usage.notABriefstackProject': { dir: string };
  'usage.invalidProjectProfile': { file: string; issues: string[] };
  'validate.projectNotFound': { dir: string };
  'validate.notADirectory': { dir: string };
  'init.settingsInvalidJson': { file: string; detail: string };
  'init.settingsInvalidShape': { file: string; field: SettingsField };
  'library.notInitialised': { dir: string };
  'library.unknownSection': { section: string; available: string[] };
  'library.invalidName': { name: string };
  'library.nameRequired': { section: string };
  'library.nameNotAllowed': { section: string };
  'library.fileNotFound': { file: string };
  'library.emptyContent': { file: string };
  'library.secretContent': { file: string; lines: number[] };
  'library.noteNotFound': { section: string; name: string };
  'library.invalidProjectStatus': { file: string; issues: string[] };
  'library.pathProtected': { file: string };
  'library.commitNotFound': { sha: string };
  'library.dirtyTree': { dir: string };
  'library.revertConflict': { sha: string; files: string[] };
  'library.revertFailed': { sha: string; detail: string };
  'library.busy': { waitedMs: number };
  'library.noteChanged': { file: string };
  'events.invalidSession': { session: string };
  'events.sessionNotFound': { session: string };
  /** Only an interrupted or cancelled creation can be archived (step 33). */
  'sessions.notUnfinished': { session: string };
  /** `<home>/archived-sessions.json` does not read back: it is not overwritten (step 33). */
  'sessions.archiveUnreadable': { file: string };
  'web.invalidPort': { value: string };
  'web.portInUse': { port: number };
  'web.uiNotBuilt': { dir: string };
  'web.invalidJson': { detail: string };
  'web.invalidBody': { issues: string[] };
  'web.invalidQuery': { name: string; value: string };
  'web.bodyTooLarge': { limit: number };
  'web.unsupportedMediaType': { contentType: string };
  'creation.unavailable': Record<string, never>;
  'creation.limit': { limit: number; active: string[] };
  'creation.noSpec': { id: string };
  'creation.claudeNotFound': Record<string, never>;
  'creation.slashCommandMissing': { command: string };
  'creation.webToolsMissing': { tools: string; server: string; status: string };
  'creation.notFound': { id: string };
  'creation.noPending': { id: string };
  'creation.wrongPending': { pendingId: string; expected: string };
  'creation.invalidAnswer': { kind: string; issues: string[] };
  /** Phase 10: the code choice at the spec cannot be approved; `items` as a build's start, `codex` and `notOffered` apart. */
  'creation.invalidCode': { issues: string[]; items: StartIssue[]; codex: boolean; notOffered: boolean; noChecks: boolean; fixed: boolean };
  'creation.noReply': { id: string };
  'chat.unavailable': Record<string, never>;
  'chat.threadNotFound': { id: string };
  'chat.busy': Record<string, never>;
  'chat.noConfirmation': { id: string };
  'improve.unavailable': Record<string, never>;
  'improve.busy': { id: string };
  'improve.notFound': { id: string };
  'improve.wrongState': { id: string; status: string };
  'improve.noRepo': { reason: string };
  'improve.notOnBranch': { branch: string; current: string };
  'improve.uncommitted': { file: string };
  'improve.conflict': { file: string };
  'improve.baseChanged': { file: string; branch: string };
  'improve.staleReview': { id: string };
  'improve.moved': Record<string, never>;
  'improve.noCheck': { id: string };
  'improve.checkBusy': { id: string };
  'improve.suggestionNotFound': { id: string };
  'skills.invalidUrl': { url: string; reason: SkillUrlProblem };
  'skills.repoNotFound': { owner: string; repo: string };
  'skills.refNotFound': { ref: string };
  'skills.pathNotFound': { path: string };
  'skills.noSkillFile': Record<string, never>;
  'skills.rateLimited': { reset: string | null };
  'skills.network': { detail: string };
  'skills.tooLarge': { what: 'file' | 'files' | 'total'; limit: number; actual: number; path?: string };
  'skills.pathTooLong': { path: string; length: number; limit: number };
  'skills.forbiddenEntry': { path: string; kind: SkillEntryProblem };
  'skills.integrity': { path: string };
  'skills.unavailable': Record<string, never>;
  'skills.notFound': { name: string };
  'skills.unreadable': { name: string };
  'skills.invalidName': { name: string };
  'skills.invalidTag': { tag: string };
  'skills.exists': { name: string; sameSource: boolean };
  'skills.wrongStatus': { name: string; status: string; action: string };
  'skills.modified': { name: string; path: string };
  'skills.fileNotFound': { name: string; path: string };
  'skills.updatePending': { name: string };
  'skills.noUpdate': { name: string };
  'skills.notApproved': { name: string; status: string };
  'skills.projectNotFound': { dir: string };
  'skills.notAProject': { dir: string };
  'skills.alreadyInstalled': { name: string };
  'skills.notInSpec': { name: string };
  'skills.outsideProjects': { dir: string };
  'skills.wouldOverwrite': { path: string };
  'skills.installRecordInvalid': { file: string };
  'usage.high': { fiveHour: number | null; sevenDay: number | null; warnFiveHour: number; warnWeek: number };
  'task.unavailable': Record<string, never>;
  'task.notFound': { id: string };
  'task.wrongState': { id: string; state: string };
  'task.projectNotFound': { project: string };
  'task.notClaudeCode': { project: string; target: string };
  'task.archived': { project: string };
  'task.folderMissing': { project: string; dir: string };
  'task.folderProtected': { project: string; dir: string };
  'task.notFromBriefstack': { project: string; dir: string };
  'task.gitMissing': Record<string, never>;
  'task.gitTooOld': { version: string; required: string };
  'task.notGitRepo': { project: string };
  'task.alreadyRepo': { project: string };
  'task.insideOtherRepo': { project: string };
  'task.noCommit': { project: string };
  'task.detachedHead': { project: string };
  'task.projectBusy': { project: string; id: string };
  'task.creationOnFolder': { project: string; holder: string };
  'task.limit': { limit: number; active: string[] };
  'task.unsafeDefinitions': { project: string; items: { file: string; reason: 'hooks' | 'mcpServers' | 'permissionMode' | 'foreignSkills' | 'unreadable' | 'settings' }[] };
  'task.unsafeChanges': { id: string; items: { file: string; reason: 'hooks' | 'mcpServers' | 'permissionMode' | 'foreignSkills' | 'unreadable' | 'settings' }[] };
  'task.worktreeChanged': { id: string };
  'task.branchChanged': { id: string };
  'task.noChecks': { id: string; project: string };
  'task.checksChanged': { id: string; project: string };
  'task.checksNotRunning': { id: string };
  'task.stopping': Record<string, never>;
  'task.invalidCheck': { command: string; problem: string };
  'task.notOnBranch': { project: string; branch: string; current: string };
  'task.dirtyFolder': { project: string; paths: string[] };
  'task.conflict': { project: string };
  'task.noChanges': { id: string };
  'task.blocked': { id: string; files: string[] };
  'task.mergeDrivers': { project: string };
  /** A build holds the project: no ordinary task starts (phase 9). */
  'task.buildOnProject': { project: string; build: string };
  /** A build's task: only the whole build is reverted (phase 9). */
  'task.inBuild': { id: string; build: string };
  /** Only a build's task runs its checks after a round (phase 9). */
  'task.notInBuild': { id: string };
  /** A build's loop drives the task now: the user's own actions on it wait (phase 9). */
  'task.heldByBuild': { id: string; build: string };
  'build.unavailable': Record<string, never>;
  'build.notFound': { id: string };
  'build.wrongState': { id: string; state: string };
  'build.noBrief': { project: string };
  'build.projectBusy': { project: string; id: string };
  /** `issues` in English; `items` the same as codes, for the page to translate (step 33). */
  'build.invalidStart': { issues: string[]; items?: StartIssue[] };
  'build.branchExists': { branch: string };
  'build.branchMoved': { branch: string };
  /** A worktree (the project folder or another) has the integration branch checked out: it is not moved or removed (step 33). */
  'build.branchCheckedOut': { branch: string };
  'build.nothingToApply': { id: string };
  /** The build's whole change is already on the default branch (step 33). */
  'build.alreadyOnBranch': { id: string; branch: string };
  'build.taskRunning': { id: string; task: string };
  /** Tasks of the build still wait for the user: approve them onto the build's branch, or discard them, before applying. */
  'build.openTasks': { id: string; tasks: number[] };
  /** A build's task the user allowed commands in: it gets no more unattended rounds. */
  'build.attendedTask': { id: string };
  /** The planner was stopped, or briefstack stopped while it planned. */
  'build.planStopped': Record<string, never>;
  /** The planner session ended with an error result (its subtype). */
  'build.planSession': { subtype: string };
  /** The planner session ended without `structured_output`. */
  'build.planNoOutput': Record<string, never>;
  'build.planSchema': { issues: string[] };
  'build.planLaterDependency': { n: number };
}

/** Why a skill link is refused. */
export type SkillUrlProblem = 'notHttps' | 'notGithub' | 'shape' | 'notSkillFile';

/** Why an entry of a skill folder is refused. */
export type SkillEntryProblem = 'symlink' | 'submodule' | 'lfs' | 'gitControl' | 'unsafePath' | 'caseCollision' | 'truncated';

export type ErrorCode = keyof ErrorParams;

export class BriefstackError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly params: ErrorParams[C];

  constructor(code: C, params: ErrorParams[C], options?: ErrorOptions) {
    super(`${code} ${JSON.stringify(params)}`, options);
    this.name = 'BriefstackError';
    this.code = code;
    this.params = params;
  }
}

export function isBriefstackError(value: unknown): value is BriefstackError {
  return value instanceof BriefstackError;
}

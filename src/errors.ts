import type { SpecIssue } from './spec/index.js';

/** What a config field should have been; rendered by the i18n catalogue. */
export type FieldExpectation = 'text' | 'lang' | 'permissionPolicy' | 'positiveInteger';

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
  'library.commitNotFound': { sha: string };
  'library.dirtyTree': { dir: string };
  'library.revertConflict': { sha: string; files: string[] };
  'library.revertFailed': { sha: string; detail: string };
  'library.busy': { waitedMs: number };
  'library.noteChanged': { file: string };
  'events.invalidSession': { session: string };
  'events.sessionNotFound': { session: string };
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
  'improve.moved': Record<string, never>;
  'improve.noCheck': { id: string };
  'improve.checkBusy': { id: string };
  'improve.suggestionNotFound': { id: string };
}

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

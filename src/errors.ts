import type { SpecIssue } from './spec/index.js';

/** What a config field should have been; rendered by the i18n catalogue. */
export type FieldExpectation = 'text' | 'lang';

/** Folders an output directory must stay out of. */
export type ProtectedRoot = 'repo' | 'library';

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

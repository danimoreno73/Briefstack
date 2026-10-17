import { describe, expect, it } from 'vitest';
import { BriefstackError, type ErrorCode, type ErrorParams } from '../../src/errors.js';
import { formatError } from '../../src/i18n/errors.js';
import { LANGS, langFromLocale, resolveLang } from '../../src/i18n/index.js';

describe('resolveLang', () => {
  it('follows BRIEFSTACK_LANG > config > OS locale > en', () => {
    expect(resolveLang({ env: { BRIEFSTACK_LANG: 'ES' }, configLang: 'en' })).toBe('es');
    expect(resolveLang({ env: {}, configLang: 'es', osLocale: 'en-US' })).toBe('es');
    expect(resolveLang({ env: { LANG: 'es_ES.UTF-8' } })).toBe('es');
    expect(resolveLang({ env: {}, osLocale: 'es-MX' })).toBe('es');
    expect(resolveLang({ env: {} })).toBe('en');
  });

  it('skips unsupported values', () => {
    expect(resolveLang({ env: { BRIEFSTACK_LANG: 'fr' }, configLang: 'es' })).toBe('es');
    expect(resolveLang({ env: { LANG: 'C.UTF-8' }, osLocale: 'es-ES' })).toBe('es');
    expect(resolveLang({ env: {}, osLocale: 'de-DE' })).toBe('en');
  });

  it('prefers LC_ALL over LANG', () => {
    expect(resolveLang({ env: { LC_ALL: 'en_GB', LANG: 'es_ES' } })).toBe('en');
  });

  it('parses locales', () => {
    expect(langFromLocale('es')).toBe('es');
    expect(langFromLocale('en_US@euro')).toBe('en');
    expect(langFromLocale(undefined)).toBeUndefined();
  });
});

describe('error catalogue', () => {
  const samples: { [C in ErrorCode]: ErrorParams[C] } = {
    'config.invalidJson': { file: 'f', detail: 'd' },
    'config.notAnObject': { file: 'f' },
    'config.invalidField': { file: 'f', field: 'lang', expected: 'lang' },
    'config.relativePath': { source: 's', value: 'v' },
    'frontmatter.unclosed': { file: 'f' },
    'frontmatter.invalidYaml': { file: 'f', detail: 'd' },
    'frontmatter.notAMapping': { file: 'f' },
    'frontmatter.blockValue': { file: 'f', field: 'model' },
    'spec.notFound': { file: 'f' },
    'spec.invalidJson': { file: 'f', detail: 'd' },
    'spec.invalid': {
      file: 'f',
      issues: [
        { path: 'slug', rule: 'slug', message: 'm' },
        { path: '', message: 'zod message' },
      ],
    },
    'scaffold.forbiddenOutput': { outDir: 'o', root: 'library', rootPath: 'r' },
    'scaffold.notADirectory': { outDir: 'o' },
    'scaffold.nonEmptyOutput': { outDir: 'o' },
    'scaffold.wouldOverwrite': { outDir: 'o', paths: ['a', 'b'] },
    'scaffold.templateNotFound': { template: 't', searched: ['x'] },
    'scaffold.templateReservedPath': { template: 't', path: '.git/config' },
    'usage.profilesNotFound': { file: 'f' },
    'usage.invalidProfiles': { file: 'f', issues: ['a', 'b'] },
    'usage.unknownProfile': { profile: 'p', available: ['saver', 'balanced'] },
    'usage.notABriefstackProject': { dir: 'd' },
    'usage.invalidProjectProfile': { file: 'f', issues: ['a'] },
    'validate.projectNotFound': { dir: 'd' },
    'validate.notADirectory': { dir: 'd' },
    'init.settingsInvalidJson': { file: 'f', detail: 'd' },
    'init.settingsInvalidShape': { file: 'f', field: 'additionalDirectories' },
    'library.notInitialised': { dir: 'd' },
    'library.unknownSection': { section: 's', available: ['profile', 'log'] },
    'library.invalidName': { name: 'N' },
    'library.nameRequired': { section: 'profile' },
    'library.nameNotAllowed': { section: 'lessons' },
    'library.fileNotFound': { file: 'f' },
    'library.emptyContent': { file: 'f' },
    'library.secretContent': { file: 'f', lines: [3] },
    'library.noteNotFound': { section: 'profile', name: 'n' },
    'library.invalidProjectStatus': { file: 'f', issues: ['target: x'] },
    'library.commitNotFound': { sha: 'abc1234' },
    'library.dirtyTree': { dir: 'd' },
    'library.revertConflict': { sha: 'abc1234', files: ['lessons.md'] },
    'library.revertFailed': { sha: 'abc1234', detail: 'd' },
    'library.busy': { waitedMs: 60000 },
    'events.invalidSession': { session: '../x' },
    'events.sessionNotFound': { session: 's' },
    'web.invalidPort': { value: 'abc' },
    'web.portInUse': { port: 4870 },
    'web.uiNotBuilt': { dir: 'd' },
    'web.invalidJson': { detail: 'd' },
    'web.invalidBody': { issues: ['idea: required'] },
    'web.invalidQuery': { name: 'from', value: 'x' },
    'web.bodyTooLarge': { limit: 65536 },
    'web.unsupportedMediaType': { contentType: 'text/plain' },
    'creation.unavailable': {},
    'creation.limit': { limit: 2, active: ['c1', 'c2'] },
    'creation.noReply': { id: 'c1' },
    'chat.unavailable': {},
    'chat.threadNotFound': { id: 't1' },
    'chat.busy': {},
    'chat.noConfirmation': { id: 'k1' },
    'creation.noSpec': { id: 'c1' },
    'creation.claudeNotFound': {},
    'creation.slashCommandMissing': { command: 'new-project' },
    'creation.webToolsMissing': { tools: 'mcp__briefstack-web__approve_spec', server: 'briefstack-web', status: 'failed' },
    'creation.notFound': { id: 'c1' },
    'creation.noPending': { id: 'c1' },
    'creation.wrongPending': { pendingId: 'p1', expected: 'p2' },
    'creation.invalidAnswer': { kind: 'question', issues: ['a'] },
  };

  it('has a distinct message for every code in every language', () => {
    for (const code of Object.keys(samples) as ErrorCode[]) {
      const error = new BriefstackError(code, samples[code]);
      const messages = LANGS.map((lang) => formatError(error, lang));
      for (const message of messages) expect(message.trim()).not.toBe('');
      expect(new Set(messages).size).toBe(LANGS.length);
    }
  });
});

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
    'paths.overlapping': { from: 'a', to: 'b' },
    'paths.targetMissing': { dir: 'd' },
    'paths.homeNotMoved': { home: 'h', from: 'a' },
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
    'library.pathProtected': { file: 'f' },
    'library.commitNotFound': { sha: 'abc1234' },
    'library.dirtyTree': { dir: 'd' },
    'library.revertConflict': { sha: 'abc1234', files: ['lessons.md'] },
    'library.revertFailed': { sha: 'abc1234', detail: 'd' },
    'library.busy': { waitedMs: 60000 },
    'library.noteChanged': { file: 'profile/style.md' },
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
    'improve.unavailable': {},
    'improve.busy': { id: 'p1' },
    'improve.notFound': { id: 'p1' },
    'improve.wrongState': { id: 'p1', status: 'applied' },
    'improve.noRepo': { reason: 'r' },
    'improve.notOnBranch': { branch: 'master', current: 'other' },
    'improve.uncommitted': { file: 'f' },
    'improve.conflict': { file: 'f' },
    'improve.baseChanged': { file: 'f', branch: 'master' },
    'improve.staleReview': { id: 'p' },
    'improve.moved': {},
    'improve.noCheck': { id: 'p1' },
    'improve.checkBusy': { id: 'p1' },
    'improve.suggestionNotFound': { id: 'g1' },
    'skills.invalidUrl': { url: 'https://example.com/x', reason: 'notGithub' },
    'skills.repoNotFound': { owner: 'acme', repo: 'skills' },
    'skills.refNotFound': { ref: 'nope' },
    'skills.pathNotFound': { path: 'skills/x' },
    'skills.noSkillFile': {},
    'skills.rateLimited': { reset: null },
    'skills.network': { detail: 'a request timed out' },
    'skills.tooLarge': { what: 'file', limit: 10, actual: 20, path: 'a.md' },
    'skills.pathTooLong': { path: 'a.md', length: 300, limit: 250 },
    'skills.forbiddenEntry': { path: 'link', kind: 'symlink' },
    'skills.integrity': { path: 'a.md' },
    'skills.unavailable': {},
    'skills.notFound': { name: 'hello' },
    'skills.unreadable': { name: 'hello' },
    'skills.invalidName': { name: 'Hello World!' },
    'skills.invalidTag': { tag: 'Bad Tag!' },
    'skills.exists': { name: 'hello', sameSource: true },
    'skills.wrongStatus': { name: 'hello', status: 'quarantine', action: 'checkUpdate' },
    'skills.modified': { name: 'hello', path: 'SKILL.md' },
    'skills.fileNotFound': { name: 'hello', path: 'x.md' },
    'skills.updatePending': { name: 'hello' },
    'skills.noUpdate': { name: 'hello' },
    'skills.notApproved': { name: 'hello', status: 'quarantine' },
    'skills.projectNotFound': { dir: '/p' },
    'skills.notAProject': { dir: '/p' },
    'skills.alreadyInstalled': { name: 'hello' },
    'skills.notInSpec': { name: 'hello' },
    'skills.outsideProjects': { dir: 'd' },
    'skills.wouldOverwrite': { path: '.claude/skills/hello' },
    'skills.installRecordInvalid': { file: '.briefstack/skills.json' },
    'usage.high': { fiveHour: 82, sevenDay: 40, warnFiveHour: 80, warnWeek: 85 },
    'task.unavailable': {},
    'task.notFound': { id: 't1' },
    'task.wrongState': { id: 't1', state: 'applied' },
    'task.projectNotFound': { project: 'garden' },
    'task.notClaudeCode': { project: 'garden', target: 'claude-app' },
    'task.archived': { project: 'garden' },
    'task.folderMissing': { project: 'garden', dir: '/p' },
    'task.folderProtected': { project: 'garden', dir: '/p' },
    'task.notFromBriefstack': { project: 'garden', dir: '/p' },
    'task.gitMissing': {},
    'task.gitTooOld': { version: '2.30', required: '2.38' },
    'task.notGitRepo': { project: 'garden' },
    'task.alreadyRepo': { project: 'garden' },
    'task.insideOtherRepo': { project: 'garden' },
    'task.noCommit': { project: 'garden' },
    'task.detachedHead': { project: 'garden' },
    'task.projectBusy': { project: 'garden', id: 't1' },
    'task.creationOnFolder': { project: 'garden', holder: 'A garden' },
    'task.limit': { limit: 2, active: ['c1', 't1'] },
    'task.unsafeDefinitions': { project: 'garden', items: [{ file: '.claude/agents/a.md', reason: 'hooks' }] },
    'task.invalidCheck': { command: 'npm test', problem: 'more than one line' },
    'task.notOnBranch': { project: 'garden', branch: 'main', current: 'dev' },
    'task.dirtyFolder': { project: 'garden', paths: ['a.txt'] },
    'task.conflict': { project: 'garden' },
    'task.noChanges': { id: 't1' },
    'task.blocked': { id: 't1', files: ['.mcp.json'] },
    'task.mergeDrivers': { project: 'garden' },
    'task.unsafeChanges': { id: 'abc123-0f0f', items: [{ file: '.claude/settings.json', reason: 'settings' }] },
    'task.worktreeChanged': { id: 'abc123-0f0f' },
    'task.branchChanged': { id: 'abc123-0f0f' },
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

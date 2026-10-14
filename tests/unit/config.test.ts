import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseConfig,
  permissionPolicyOf,
  readConfig,
  resolveHome,
  resolvePaths,
  updateConfig,
} from '../../src/config/config.js';
import type { PathEnv } from '../../src/config/paths.js';
import { BriefstackError } from '../../src/errors.js';
import { formatError } from '../../src/i18n/errors.js';

const styles = [
  { name: 'win32', pathApi: path.win32, home: 'C:\\Users\\someone', other: 'D:\\vault' },
  { name: 'posix', pathApi: path.posix, home: '/home/someone', other: '/srv/vault' },
] as const;

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof BriefstackError) return error.code;
    throw error;
  }
  return undefined;
}

describe.each(styles)('resolvePaths ($name)', ({ pathApi, home, other }) => {
  const make = (env: Record<string, string> = {}): PathEnv => ({
    env,
    homedir: home,
    pathApi,
    caseInsensitive: false,
  });
  const join = (...parts: string[]) => pathApi.join(...parts);

  it('uses defaults under the home directory', () => {
    expect(resolvePaths({}, make())).toEqual({
      home: join(home, '.briefstack'),
      configFile: join(home, '.briefstack', 'config.json'),
      userProfilesFile: join(home, '.briefstack', 'usage-profiles.json'),
      sessionsDir: join(home, '.briefstack', 'sessions'),
      libraryDir: join(home, '.briefstack', 'library'),
      projectsDir: join(home, 'briefstack-projects'),
    });
  });

  it('applies config values, expanding ~', () => {
    const paths = resolvePaths({ libraryDir: other, projectsDir: '~/projects' }, make());
    expect(paths.libraryDir).toBe(other);
    expect(paths.projectsDir).toBe(join(home, 'projects'));
  });

  it('lets environment variables win over config', () => {
    const env = make({ BRIEFSTACK_HOME: '~/bs', BRIEFSTACK_LIBRARY: join(other, 'lib') });
    const paths = resolvePaths({ libraryDir: other }, env);
    expect(paths.home).toBe(join(home, 'bs'));
    expect(paths.configFile).toBe(join(home, 'bs', 'config.json'));
    expect(paths.libraryDir).toBe(join(other, 'lib'));
  });

  it('ignores empty environment variables', () => {
    expect(resolveHome(make({ BRIEFSTACK_HOME: '  ' }))).toBe(join(home, '.briefstack'));
  });

  it('rejects relative paths from env and config', () => {
    expect(errorCode(() => resolveHome(make({ BRIEFSTACK_HOME: 'bs' })))).toBe(
      'config.relativePath',
    );
    expect(errorCode(() => resolvePaths({ libraryDir: 'lib' }, make()))).toBe(
      'config.relativePath',
    );
    expect(errorCode(() => resolvePaths({ projectsDir: './p' }, make()))).toBe(
      'config.relativePath',
    );
  });
});

describe('parseConfig', () => {
  it('accepts known fields and ignores unknown ones', () => {
    const text = JSON.stringify({ activeProfile: 'max', lang: 'es', extra: 1 });
    expect(parseConfig(text, 'c.json')).toEqual({ activeProfile: 'max', lang: 'es' });
  });

  it('rejects bad JSON, non-objects and bad fields', () => {
    expect(errorCode(() => parseConfig('{', 'c.json'))).toBe('config.invalidJson');
    expect(errorCode(() => parseConfig('[]', 'c.json'))).toBe('config.notAnObject');
    expect(errorCode(() => parseConfig('{"lang":"fr"}', 'c.json'))).toBe('config.invalidField');
    expect(errorCode(() => parseConfig('{"projectsDir":""}', 'c.json'))).toBe(
      'config.invalidField',
    );
    expect(errorCode(() => parseConfig('{"activeProfile":3}', 'c.json'))).toBe(
      'config.invalidField',
    );
  });

  it('reads the permission policy, ask by default', () => {
    expect(parseConfig('{"permissionPolicy":"unattended"}', 'c.json')).toEqual({ permissionPolicy: 'unattended' });
    expect(permissionPolicyOf(parseConfig('{"permissionPolicy":"ask"}', 'c.json'))).toBe('ask');
    expect(permissionPolicyOf(parseConfig('{}', 'c.json'))).toBe('ask');
    let caught: unknown;
    try {
      parseConfig('{"permissionPolicy":"always"}', 'c.json');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'config.invalidField',
      params: { field: 'permissionPolicy', expected: 'permissionPolicy' },
    });
    expect(formatError(caught as BriefstackError, 'en')).toContain('one of: ask, unattended');
    expect(formatError(caught as BriefstackError, 'es')).toContain('uno de: ask, unattended');
  });
});

describe('readConfig / updateConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as empty', async () => {
    expect(await readConfig(path.join(dir, 'config.json'))).toEqual({});
  });

  it('creates, merges and removes fields, keeping unknown ones', async () => {
    const file = path.join(dir, 'nested', 'config.json');
    await updateConfig(file, { activeProfile: 'saver' });
    expect(await readConfig(file)).toEqual({ activeProfile: 'saver' });

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...raw, custom: true }), 'utf8');

    const updated = await updateConfig(file, { lang: 'es', activeProfile: undefined });
    expect(updated).toEqual({ lang: 'es' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ custom: true, lang: 'es' });
  });

  it('refuses to write an invalid value', async () => {
    const file = path.join(dir, 'config.json');
    await expect(updateConfig(file, { projectsDir: ' ' })).rejects.toMatchObject({
      code: 'config.invalidField',
    });
  });
});

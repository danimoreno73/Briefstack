import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config/config.js';
import type { PathEnv } from '../../src/config/paths.js';
import { setProjectsDir } from '../../src/library/index.js';
import { tempDir } from '../helpers.js';

describe('setProjectsDir', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let pathEnv: PathEnv;
  let repoDir: string;
  const settingsFile = () => path.join(repoDir, '.claude', 'settings.local.json');
  const readSettings = async () => JSON.parse(await readFile(settingsFile(), 'utf8')) as { permissions: { additionalDirectories: string[] } };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('projects-dir'));
    repoDir = path.join(dir, 'repo');
    pathEnv = {
      env: { BRIEFSTACK_HOME: path.join(dir, 'home') },
      homedir: path.join(dir, 'user'),
      pathApi: path,
      caseInsensitive: process.platform !== 'linux',
    };
  });
  afterEach(() => cleanup());

  it('saves the folder, creates it and adds it to the settings, keeping the old entry', async () => {
    const old = path.join(dir, 'user', 'briefstack-projects');
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    const oldEntry = old.replace(/\\/g, '/');
    await writeFile(settingsFile(), JSON.stringify({ permissions: { allow: ['Read'], additionalDirectories: [oldEntry] } }), 'utf8');

    const target = path.join(dir, 'work', 'projects');
    const result = await setProjectsDir({ pathEnv, repoDir, dir: target });
    expect(result).toMatchObject({ previous: old, projectsDir: target, configChanged: true, created: true });
    expect(result.settings).toEqual([{ file: settingsFile(), entry: target.replace(/\\/g, '/'), added: true }]);
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await readConfig(path.join(dir, 'home', 'config.json'))).toEqual({ projectsDir: target });
    const settings = await readSettings();
    expect(settings.permissions.additionalDirectories).toEqual([oldEntry, target.replace(/\\/g, '/')]);
    expect(settings.permissions).toMatchObject({ allow: ['Read'] });

    const again = await setProjectsDir({ pathEnv, repoDir, dir: target });
    expect(again).toMatchObject({ previous: target, configChanged: false, created: false });
    expect(again.settings[0]?.added).toBe(false);
  });

  it('expands ~ like the config does', async () => {
    const result = await setProjectsDir({ pathEnv, repoDir, dir: '~/elsewhere' });
    expect(result.projectsDir).toBe(path.join(dir, 'user', 'elsewhere'));
  });

  it('refuses relative paths for both path styles, before writing anything', async () => {
    const styles = [
      { pathApi: path.win32, homedir: 'C:\\Users\\someone', bad: ['projects', '\\projects', 'D:projects'] },
      { pathApi: path.posix, homedir: '/home/someone', bad: ['projects', './projects'] },
    ];
    for (const style of styles) {
      for (const value of style.bad) {
        const env: PathEnv = { ...pathEnv, pathApi: style.pathApi, homedir: style.homedir };
        await expect(setProjectsDir({ pathEnv: env, repoDir, dir: value })).rejects.toMatchObject({
          code: 'config.relativePath',
          params: { source: 'projectsDir', value },
        });
      }
    }
    await expect(stat(path.join(dir, 'home'))).rejects.toThrow();
    await expect(stat(settingsFile())).rejects.toThrow();
  });

  it('stops before writing when the settings file is invalid', async () => {
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    await writeFile(settingsFile(), '{ not json', 'utf8');
    const target = path.join(dir, 'work', 'projects');
    await expect(setProjectsDir({ pathEnv, repoDir, dir: target })).rejects.toMatchObject({ code: 'init.settingsInvalidJson' });
    await expect(stat(target)).rejects.toThrow();
    await expect(stat(path.join(dir, 'home', 'config.json'))).rejects.toThrow();
  });
});

import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../../src/library/git.js';
import { commitProject, noRepoCodeArgs } from '../../src/scaffold/commit.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

describe('commitProject', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let project: string;
  const marker = (name: string) => path.join(dir, name).replaceAll('\\', '/');
  const exists = (file: string) => stat(file).then(() => true, () => false);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('project-commit'));
    project = path.join(dir, 'app');
    await writeTree(project, { '.briefstack/profile.json': '{}', 'CLAUDE.md': '# App\n' });
    await git(project, ['init', '--quiet']);
  });
  afterEach(() => cleanup());

  it('never runs the project hooks or its fsmonitor', async () => {
    const hook = path.join(project, '.git', 'hooks', 'pre-commit');
    const monitor = path.join(dir, 'monitor.sh');
    await writeTree(dir, {
      'app/.git/hooks/pre-commit': `#!/bin/sh\necho ran > "${marker('hook-ran')}"\n`,
      'monitor.sh': `#!/bin/sh\necho ran > "${marker('monitor-ran')}"\nexit 1\n`,
    });
    await chmod(hook, 0o755);
    await chmod(monitor, 0o755);
    await git(project, ['config', 'core.fsmonitor', monitor.replaceAll('\\', '/')]);

    const result = await commitProject(project);
    expect(result).toMatchObject({ committed: true });
    expect(await exists(path.join(dir, 'hook-ran'))).toBe(false);
    expect(await exists(path.join(dir, 'monitor-ran'))).toBe(false);
    expect((await git(project, ['log', '--format=%s'])).trim()).toBe('Prepare the project with briefstack');
  });

  it('turns hooks off with an empty folder and fsmonitor off', () => {
    expect(noRepoCodeArgs('E')).toEqual(['-c', 'core.hooksPath=E', '-c', 'core.fsmonitor=false']);
  });
});

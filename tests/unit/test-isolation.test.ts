import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths, systemPathEnv } from '../../src/config/index.js';

const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

describe('test isolation', () => {
  it('keeps the user data out of reach: home, library and projects are in the temp folder', () => {
    const pathEnv = systemPathEnv();
    const paths = resolvePaths({}, pathEnv);
    for (const target of [paths.home, paths.libraryDir, paths.sessionsDir, paths.projectsDir, pathEnv.homedir, os.homedir()]) {
      expect(inside(target, os.tmpdir()), target).toBe(true);
    }
    expect(process.env.BRIEFSTACK_LIBRARY).toBeUndefined();
  });
});

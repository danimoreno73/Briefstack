import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';

describe('repo permission rules', () => {
  it('allows only the briefstack CLI, run through npm', async () => {
    // A prefix rule never approves a chained, piped or nested command
    // (decisions.md, "Allow rule for the CLI"), so nothing broader is needed.
    const settings = JSON.parse(await readFile(path.join(PACKAGE_ROOT, '.claude', 'settings.json'), 'utf8')) as {
      permissions?: Record<string, unknown>;
    };
    expect(settings.permissions).toEqual({
      allow: ['Bash(npm run --silent briefstack *)', 'PowerShell(npm run --silent briefstack *)'],
    });
  });
});

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
    expect(settings.permissions?.allow).toEqual(['Bash(npm run --silent briefstack *)', 'PowerShell(npm run --silent briefstack *)']);
    expect(Object.keys(settings.permissions ?? {}).sort()).toEqual(['allow', 'deny']);
  });

  it('denies the shell forms of editing a file, so files are written with Write and Edit (BRIEF-release §6)', async () => {
    // Each rule was checked against a real session (decisions.md, "Release", "Deny rules").
    // A Bash redirection (`>`, `>>`) cannot be denied this way: Claude Code checks only its target.
    const settings = JSON.parse(await readFile(path.join(PACKAGE_ROOT, '.claude', 'settings.json'), 'utf8')) as {
      permissions?: { deny?: string[] };
    };
    const deny = settings.permissions?.deny ?? [];
    for (const rule of ['Bash(sed *-i*)', 'Bash(tee *)', 'Bash(node -e *)', 'Bash(python -c *)', 'PowerShell(Set-Content *)', 'PowerShell(Out-File *)', 'PowerShell(* >*)']) {
      expect(deny).toContain(rule);
    }
    // Nothing that would stop the CLI the agents run, or reading.
    for (const rule of deny) expect(rule).not.toMatch(/^(Read|Edit|Write)\b|npm|briefstack/);
  });

  it('sets no model: the session model comes only from the usage profile', async () => {
    // Project settings rank above `--model` in Claude Code's model order, so they must not name one.
    const settings = JSON.parse(await readFile(path.join(PACKAGE_ROOT, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings).not.toHaveProperty('model');
    expect((settings.env as Record<string, unknown> | undefined) ?? {}).not.toHaveProperty('ANTHROPIC_MODEL');
  });
});

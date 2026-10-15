import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import type { SpecInput } from '../src/spec/index.js';
import { baseProfilesFile, loadUsageProfiles, type UsageProfiles } from '../src/usage/profiles.js';

/** A minimal valid spec; override fields per test. */
export function specInput(overrides: Partial<SpecInput> = {}): SpecInput {
  return {
    specVersion: 1,
    name: 'Garden planner',
    slug: 'garden-planner',
    summary: 'Plan a vegetable garden across seasons.',
    language: 'en',
    type: 'generic',
    target: 'claude-code',
    profile: 'balanced',
    goal: 'Know what to plant and when.',
    audience: 'A home gardener.',
    deliverables: ['A planting calendar'],
    doneWhen: ['The calendar covers a full year'],
    ...overrides,
  };
}

/** Creates a temp folder and returns it with a cleanup function. */
export async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `briefstack-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

/** Writes files given as `{ 'a/b.md': 'content' }` under `root`. */
export async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** The base usage presets shipped in `library/usage-profiles.json`. */
export function baseProfiles(): Promise<UsageProfiles> {
  return loadUsageProfiles({ baseFile: baseProfilesFile() });
}

/**
 * Runs git without global or system config for the current test file: no
 * user identity, no signing, nothing from the developer's machine.
 */
export function useHermeticGit(): void {
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const temp = await tempDir('gitconfig');
    cleanup = temp.cleanup;
    const empty = path.join(temp.dir, 'gitconfig');
    await writeFile(empty, '', 'utf8');
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  afterAll(async () => {
    for (const [key, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanup?.();
  });
}

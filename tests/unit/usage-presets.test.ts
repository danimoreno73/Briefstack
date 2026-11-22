import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseProfilesFile, createUserPreset, loadUsageProfiles } from '../../src/usage/index.js';
import { tempDir } from '../helpers.js';

// "New preset based on…" (IDEAS §3; phase 9, step 33): the user's usage-profiles.json only, under the CLI's schema.

let dir: string;
let cleanup: () => Promise<void>;
let userFile: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('usage-presets'));
  userFile = path.join(dir, 'home', 'usage-profiles.json');
});
afterEach(() => cleanup());

const files = () => ({ baseFile: baseProfilesFile(), userFile });

describe('a user preset from another one', () => {
  it('copies the base, changes what was asked, and is read back by the CLI\'s loader as a user preset', async () => {
    const created = await createUserPreset(files(), {
      name: 'deep-dive',
      base: 'balanced',
      label: { en: 'Deep dive', es: 'A fondo' },
      effort: 'high',
      agents: { architect: { model: 'opus', effort: 'max' }, reviewer: { model: 'sonnet' } },
    });
    expect(created.name).toBe('deep-dive');
    const profiles = await loadUsageProfiles(files());
    const base = profiles.presets.balanced;
    const preset = profiles.presets['deep-dive'];
    expect(profiles.sources['deep-dive']).toBe('user');
    expect(preset).toMatchObject({ label: { en: 'Deep dive', es: 'A fondo' }, effort: 'high', sessionModel: base?.sessionModel, chat: base?.chat, work: base?.work, tiers: base?.tiers });
    expect(preset?.agents.architect).toEqual({ model: 'opus', effort: 'max' });
    expect(preset?.agents.reviewer).toBe('sonnet');
    expect(preset?.agents.interviewer).toEqual(base?.agents.interviewer);
  });

  it('refuses a name that exists, a base that does not, and a preset the schema refuses, writing nothing', async () => {
    await expect(createUserPreset(files(), { name: 'balanced', base: 'saver', label: { en: 'x', es: 'x' } })).rejects.toMatchObject({ code: 'usage.presetExists' });
    await expect(createUserPreset(files(), { name: 'mine', base: 'nope', label: { en: 'x', es: 'x' } })).rejects.toMatchObject({ code: 'usage.unknownProfile' });
    await expect(createUserPreset(files(), { name: 'mine', base: 'saver', label: { en: 'x', es: 'x' }, agents: { architect: { model: 'not a model!' } } })).rejects.toMatchObject({ code: 'usage.invalidProfiles' });
    await expect(readFile(userFile, 'utf8')).rejects.toBeDefined();
  });

  it('keeps the presets already in the user\'s file, and never overwrites one that does not read back', async () => {
    await createUserPreset(files(), { name: 'one', base: 'saver', label: { en: 'One', es: 'Uno' } });
    await createUserPreset(files(), { name: 'two', base: 'one', label: { en: 'Two', es: 'Dos' } });
    expect(Object.keys(JSON.parse(await readFile(userFile, 'utf8')).profiles)).toEqual(['one', 'two']);
    await writeFile(userFile, '{ broken', 'utf8');
    await expect(createUserPreset(files(), { name: 'three', base: 'saver', label: { en: 'Three', es: 'Tres' } })).rejects.toMatchObject({ code: 'usage.invalidProfiles' });
    expect(await readFile(userFile, 'utf8')).toBe('{ broken');
  });
});

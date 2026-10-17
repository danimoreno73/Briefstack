import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { scaffold } from '../../src/scaffold/index.js';
import { parseSpec } from '../../src/spec/index.js';
import {
  FLOW_AGENTS,
  agentSetting,
  applyProfileToAgents,
  applyProfileToProject,
  baseProfilesFile,
  checkAgentDrift,
  getPreset,
  loadUsageProfiles,
  parseProfilesFile,
  resolveActiveProfile,
  usageEnvWarnings,
  type UsagePresetInput,
  type UsageProfiles,
} from '../../src/usage/index.js';
import { baseProfiles, specInput, tempDir, writeTree } from '../helpers.js';

const execFileAsync = promisify(execFile);
const REPO_AGENTS = path.join(PACKAGE_ROOT, '.claude', 'agents');

/** A user preset unlike any base one. */
const CUSTOM_PRESET: UsagePresetInput = {
  label: { en: 'Custom', es: 'Propio' },
  sessionModel: 'claude-sonnet-4-5',
  effort: 'xhigh',
  chat: { model: 'haiku', effort: 'low' },
  agents: {
    interviewer: 'inherit',
    researcher: { model: 'haiku', effort: 'low' },
    architect: 'claude-opus-4-1',
    generator: 'fable',
    reviewer: { model: 'opus', effort: 'max' },
  },
  tiers: { light: 'haiku', standard: 'haiku', heavy: 'sonnet' },
  research: 'required-only',
  reviewRounds: 1,
};

async function readAgents(dir: string): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()) {
    const target = path.join(dir, file);
    result[file] = parseFrontmatter(await readFile(target, 'utf8'), target).data;
  }
  return result;
}

async function readBytes(dir: string): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  for (const file of (await readdir(dir)).sort()) result[file] = await readFile(path.join(dir, file));
  return result;
}

describe('usage profiles data', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('usage-data'));
  });
  afterEach(() => cleanup());

  it('ships saver, balanced and max, with balanced as default', async () => {
    const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile() });
    expect(Object.keys(profiles.presets)).toEqual(['saver', 'balanced', 'max']);
    expect(profiles.defaultProfile).toBe('balanced');
    expect(profiles.presets.saver?.reviewRounds).toBe(1);
    expect(profiles.presets.balanced?.reviewRounds).toBe(2);
    expect(profiles.presets.max?.reviewRounds).toBe(3);
    expect(profiles.presets.saver?.research).toBe('required-only');
    for (const preset of Object.values(profiles.presets)) {
      for (const label of Object.values(preset.label)) expect(label).not.toMatch(/\d|token|\$|€/i);
    }
  });

  it('merges user presets by name, the user winning', async () => {
    const userFile = path.join(dir, 'usage-profiles.json');
    await writeFile(
      userFile,
      JSON.stringify({ profiles: { max: CUSTOM_PRESET, mine: CUSTOM_PRESET } }),
      'utf8',
    );
    const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile(), userFile });
    expect(Object.keys(profiles.presets)).toEqual(['saver', 'balanced', 'max', 'mine']);
    expect(profiles.presets.max?.sessionModel).toBe('claude-sonnet-4-5');
    expect(profiles.sources).toEqual({ saver: 'base', balanced: 'base', max: 'user', mine: 'user' });
    expect(profiles.defaultProfile).toBe('balanced');
  });

  it('treats a missing user file as no user presets', async () => {
    const profiles = await loadUsageProfiles({
      baseFile: baseProfilesFile(),
      userFile: path.join(dir, 'missing.json'),
    });
    expect(Object.keys(profiles.presets)).toEqual(['saver', 'balanced', 'max']);
  });

  it('rejects an invalid user file with a coded error', async () => {
    const userFile = path.join(dir, 'usage-profiles.json');
    await writeFile(userFile, '{ not json', 'utf8');
    await expect(loadUsageProfiles({ baseFile: baseProfilesFile(), userFile })).rejects.toMatchObject({
      code: 'usage.invalidProfiles',
      params: { file: userFile },
    });

    const bad = { ...CUSTOM_PRESET, effort: 'extreme', agents: { interviewer: 'sonnet' } };
    await writeFile(userFile, JSON.stringify({ profiles: { mine: bad } }), 'utf8');
    const error = await loadUsageProfiles({ baseFile: baseProfilesFile(), userFile }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'usage.invalidProfiles' });
    const issues = (error as { params: { issues: string[] } }).params.issues;
    expect(issues.some((issue) => issue.startsWith('profiles.mine.effort'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('profiles.mine.agents.reviewer'))).toBe(true);
  });

  it('gives every base preset the chat model and effort of BRIEF-phase-4 §8.3', async () => {
    const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile() });
    expect(profiles.presets.saver?.chat).toEqual({ model: 'haiku', effort: 'low' });
    expect(profiles.presets.balanced?.chat).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(profiles.presets.max?.chat).toEqual({ model: 'opus', effort: 'high' });
  });

  it('refuses a user preset without the chat model and effort, and names the field', () => {
    const withoutChat: Partial<UsagePresetInput> = { ...CUSTOM_PRESET };
    delete withoutChat.chat;
    const error = (() => {
      try {
        parseProfilesFile(JSON.stringify({ profiles: { mine: withoutChat } }), 'f');
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toMatchObject({ code: 'usage.invalidProfiles' });
    expect((error as { params: { issues: string[] } }).params.issues.some((issue) => issue.startsWith('profiles.mine.chat'))).toBe(true);
    for (const chat of [{ model: 'haiku' }, { model: 'two words', effort: 'low' }, { model: 'haiku', effort: 'extreme' }, { model: 'haiku', effort: 'low', extra: 1 }]) {
      expect(() => parseProfilesFile(JSON.stringify({ profiles: { mine: { ...CUSTOM_PRESET, chat } } }), 'f'), JSON.stringify(chat)).toThrow(
        expect.objectContaining({ code: 'usage.invalidProfiles' }),
      );
    }
  });

  it('rejects bad profile names and model values', () => {
    const file = JSON.stringify({ profiles: { 'Bad Name': CUSTOM_PRESET } });
    expect(() => parseProfilesFile(file, 'f')).toThrow(expect.objectContaining({ code: 'usage.invalidProfiles' }));
    const model = JSON.stringify({ profiles: { ok: { ...CUSTOM_PRESET, sessionModel: 'two words' } } });
    expect(() => parseProfilesFile(model, 'f')).toThrow(expect.objectContaining({ code: 'usage.invalidProfiles' }));
  });

  it('reports a missing base file', async () => {
    await expect(loadUsageProfiles({ baseFile: path.join(dir, 'none.json') })).rejects.toMatchObject({
      code: 'usage.profilesNotFound',
    });
  });

  it('resolves the active profile from config, else the default', async () => {
    const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile() });
    expect(resolveActiveProfile({}, profiles)).toMatchObject({ name: 'balanced', fromConfig: false });
    expect(resolveActiveProfile({ activeProfile: 'max' }, profiles)).toMatchObject({
      name: 'max',
      fromConfig: true,
    });
    expect(() => resolveActiveProfile({ activeProfile: 'turbo' }, profiles)).toThrow(
      expect.objectContaining({
        code: 'usage.unknownProfile',
        params: { profile: 'turbo', available: ['saver', 'balanced', 'max'] },
      }),
    );
  });

  it('applies per-agent effort overrides', () => {
    const profiles: UsageProfiles = {
      defaultProfile: 'mine',
      presets: { mine: parseProfilesFile(JSON.stringify({ profiles: { mine: CUSTOM_PRESET } }), 'f').profiles.mine! },
      sources: { mine: 'user' },
    };
    const preset = getPreset(profiles, 'mine');
    expect(agentSetting(preset, 'researcher')).toEqual({ model: 'haiku', effort: 'low' });
    expect(agentSetting(preset, 'architect')).toEqual({ model: 'claude-opus-4-1', effort: 'xhigh' });
    expect(agentSetting(preset, 'toString')).toBeUndefined();
  });
});

describe('applyProfileToAgents (usage test)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let agentsDir: string;
  let profiles: UsageProfiles;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('usage-apply'));
    agentsDir = path.join(dir, 'agents');
    await cp(REPO_AGENTS, agentsDir, { recursive: true });
    const userFile = path.join(dir, 'usage-profiles.json');
    await writeFile(userFile, JSON.stringify({ profiles: { custom: CUSTOM_PRESET } }), 'utf8');
    profiles = await loadUsageProfiles({ baseFile: baseProfilesFile(), userFile });
  });
  afterEach(() => cleanup());

  it('the repo agent files are the five flow agents', async () => {
    expect(Object.keys(await readAgents(agentsDir))).toEqual(
      [...FLOW_AGENTS].sort().map((agent) => `${agent}.md`),
    );
  });

  it.each(['saver', 'balanced', 'max', 'custom'])(
    '%s: every agent file gets the model and effort from the data file',
    async (name) => {
      const preset = getPreset(profiles, name);
      const before = await readAgents(agentsDir);
      await applyProfileToAgents(agentsDir, preset);
      const after = await readAgents(agentsDir);

      for (const agent of FLOW_AGENTS) {
        const file = `${agent}.md`;
        expect(after[file]).toEqual({ ...before[file], ...agentSetting(preset, agent) });
      }
    },
  );

  it('balanced leaves the unchanged agent files byte-for-byte identical', async () => {
    const before = await readBytes(agentsDir);
    const result = await applyProfileToAgents(agentsDir, getPreset(profiles, 'balanced'));
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toHaveLength(FLOW_AGENTS.length);
    expect(await readBytes(agentsDir)).toEqual(before);
  });

  it('touches only model and effort, and can go back to balanced', async () => {
    const before = await readBytes(agentsDir);
    const result = await applyProfileToAgents(agentsDir, getPreset(profiles, 'max'));
    expect(result.changed).toEqual(['generator.md', 'interviewer.md', 'researcher.md', 'reviewer.md', 'architect.md'].sort());

    const original = (before['reviewer.md'] as Buffer).toString('utf8');
    const changed = await readFile(path.join(agentsDir, 'reviewer.md'), 'utf8');
    expect(changed).toBe(original.replace('model: sonnet', 'model: opus').replace('effort: medium', 'effort: high'));

    await applyProfileToAgents(agentsDir, getPreset(profiles, 'balanced'));
    expect(await readBytes(agentsDir)).toEqual(before);
  });

  it('leaves agents the preset does not name alone and reports them', async () => {
    const extra = '---\nname: helper\nmodel: haiku\n---\nBody\n';
    await writeFile(path.join(agentsDir, 'helper.md'), extra, 'utf8');
    await writeFile(path.join(agentsDir, 'notes.txt'), 'not an agent', 'utf8');
    const result = await applyProfileToAgents(agentsDir, getPreset(profiles, 'max'));
    expect(result.notInProfile).toEqual(['helper.md']);
    expect(await readFile(path.join(agentsDir, 'helper.md'), 'utf8')).toBe(extra);
  });

  it('returns an empty result for a missing folder', async () => {
    const result = await applyProfileToAgents(path.join(dir, 'none'), getPreset(profiles, 'max'));
    expect(result).toMatchObject({ changed: [], unchanged: [], notInProfile: [] });
  });
});

const git = (args: string[], cwd: string) =>
  execFileAsync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, windowsHide: true },
  );

describe('checkAgentDrift', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('usage-drift'));
  });
  afterEach(() => cleanup());

  it('warns when model or effort differ from HEAD', async () => {
    const repo = path.join(dir, 'repo');
    const agentsDir = path.join(repo, '.claude', 'agents');
    await writeTree(agentsDir, {
      'reviewer.md': '---\nname: reviewer\nmodel: sonnet\neffort: medium\n---\nBody\n',
      'architect.md': '---\nname: architect\nmodel: opus\neffort: medium\n---\nBody\n',
    });
    await git(['init', '--quiet'], repo);
    await git(['add', '.'], repo);
    await git(['commit', '--quiet', '-m', 'agents'], repo);

    expect(await checkAgentDrift(agentsDir)).toEqual({ status: 'checked', drift: [], uncommitted: [] });

    const reviewer = path.join(agentsDir, 'reviewer.md');
    await writeFile(reviewer, (await readFile(reviewer, 'utf8')).replace('model: sonnet', 'model: opus'), 'utf8');
    await writeFile(path.join(agentsDir, 'new.md'), '---\nname: new\n---\n', 'utf8');

    expect(await checkAgentDrift(agentsDir)).toEqual({
      status: 'checked',
      drift: [{ file: 'reviewer.md', field: 'model', committed: 'sonnet', current: 'opus' }],
      uncommitted: ['new.md'],
    });
  });

  it('is skipped outside a git repository or without commits', async () => {
    const agentsDir = path.join(dir, 'plain', 'agents');
    await writeTree(agentsDir, { 'a.md': '---\nmodel: opus\n---\n' });
    expect(await checkAgentDrift(agentsDir)).toEqual({ status: 'skipped' });

    const empty = path.join(dir, 'empty');
    await mkdir(path.join(empty, 'agents'), { recursive: true });
    await git(['init', '--quiet'], empty);
    expect(await checkAgentDrift(path.join(empty, 'agents'))).toEqual({ status: 'skipped' });

    expect(await checkAgentDrift(path.join(dir, 'missing'))).toEqual({ status: 'skipped' });
  });
});

describe('usageEnvWarnings', () => {
  it('warns about variables that beat the frontmatter', () => {
    expect(
      usageEnvWarnings({
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
      }),
    ).toEqual([
      { field: 'model', variable: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', value: '1' },
      { field: 'effort', variable: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'high' },
    ]);
  });

  it('ignores unset, empty and lower-priority variables', () => {
    expect(usageEnvWarnings({ CLAUDE_CODE_EFFORT_LEVEL: ' ', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })).toEqual([]);
  });
});

describe('applyProfileToProject', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let profiles: UsageProfiles;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('usage-project'));
    await writeTree(path.join(dir, 'templates'), { 'generic/common/CLAUDE.md': '# {{name}}\n' });
    profiles = await loadUsageProfiles({ baseFile: baseProfilesFile() });
  });
  afterEach(() => cleanup());

  async function makeProject(target: 'claude-code' | 'claude-app' = 'claude-code'): Promise<string> {
    const outDir = path.join(dir, 'projects', target);
    const spec = parseSpec(
      specInput({
        target,
        agents:
          target === 'claude-code'
            ? [
                { name: 'checker', description: 'Checks things', tools: ['Read'], tier: 'light' },
                { name: 'writer', description: 'Writes things', tools: ['Read', 'Write'], tier: 'standard' },
                { name: 'planner', description: 'Plans things', tools: ['Read'], tier: 'heavy' },
              ]
            : [],
      }),
      'spec.json',
    );
    await scaffold(spec, outDir, {
      protectedDirs: [{ root: 'repo', path: path.join(dir, 'repo') }],
      templateRoots: [path.join(dir, 'templates')],
      profiles: await baseProfiles(),
      gitInit: false,
    });
    return outDir;
  }

  const readProfile = async (outDir: string) =>
    JSON.parse(await readFile(path.join(outDir, '.briefstack', 'profile.json'), 'utf8')) as {
      profile: string;
      agents: Record<string, string>;
    };

  it('refuses a folder briefstack did not create', async () => {
    const foreign = path.join(dir, 'foreign');
    await writeTree(foreign, { '.claude/agents/a.md': '---\nname: a\nmodel: haiku\n---\n' });
    await expect(applyProfileToProject(foreign, 'max', profiles)).rejects.toMatchObject({
      code: 'usage.notABriefstackProject',
      params: { dir: foreign },
    });
    expect(await readFile(path.join(foreign, '.claude', 'agents', 'a.md'), 'utf8')).toContain('model: haiku');
    await expect(applyProfileToProject(path.join(dir, 'missing'), 'max', profiles)).rejects.toMatchObject({
      code: 'usage.notABriefstackProject',
    });
  });

  it.each(['saver', 'balanced', 'max'])('%s: maps each tier to its model and records the profile', async (name) => {
    const outDir = await makeProject();
    const preset = getPreset(profiles, name);
    const result = await applyProfileToProject(outDir, name, profiles);

    // scaffold already applied the spec's profile (balanced) when it created the project.
    expect(result.changed).toEqual(name === 'balanced' ? [] : ['checker.md', 'planner.md', 'writer.md']);
    expect(result.previousProfile).toBe('balanced');
    expect(result.profileFileChanged).toBe(name !== 'balanced');
    const agents = await readAgents(path.join(outDir, '.claude', 'agents'));
    expect(agents['checker.md']).toMatchObject({ model: preset.tiers.light, effort: preset.effort });
    expect(agents['writer.md']).toMatchObject({ model: preset.tiers.standard, effort: preset.effort });
    expect(agents['planner.md']).toMatchObject({ model: preset.tiers.heavy, effort: preset.effort });
    expect(await readProfile(outDir)).toEqual({
      profile: name,
      agents: { checker: 'light', writer: 'standard', planner: 'heavy' },
    });
  });

  it('is a no-op the second time', async () => {
    const outDir = await makeProject();
    await applyProfileToProject(outDir, 'max', profiles);
    const again = await applyProfileToProject(outDir, 'max', profiles);
    expect(again.changed).toEqual([]);
    expect(again.profileFileChanged).toBe(false);
  });

  it('updates profile.json for a project without agents', async () => {
    const outDir = await makeProject('claude-app');
    const result = await applyProfileToProject(outDir, 'saver', profiles);
    expect(result.changed).toEqual([]);
    expect((await readProfile(outDir)).profile).toBe('saver');
  });

  it('reports untiered agent files and listed agents without a file', async () => {
    const outDir = await makeProject();
    await writeFile(path.join(outDir, '.claude', 'agents', 'extra.md'), '---\nname: extra\n---\n', 'utf8');
    const profileFile = path.join(outDir, '.briefstack', 'profile.json');
    const raw = await readProfile(outDir);
    await writeFile(profileFile, JSON.stringify({ ...raw, agents: { ...raw.agents, ghost: 'light' } }), 'utf8');

    const result = await applyProfileToProject(outDir, 'max', profiles);
    expect(result.notInProfile).toEqual(['extra.md']);
    expect(result.missingAgents).toEqual(['ghost']);
  });

  it('rejects an unknown profile or a broken profile.json without writing', async () => {
    const outDir = await makeProject();
    const agentsDir = path.join(outDir, '.claude', 'agents');
    const before = await readBytes(agentsDir);
    await expect(applyProfileToProject(outDir, 'turbo', profiles)).rejects.toMatchObject({
      code: 'usage.unknownProfile',
    });

    await writeFile(path.join(outDir, '.briefstack', 'profile.json'), '{"profile":"max","agents":{"a":"huge"}}');
    await expect(applyProfileToProject(outDir, 'max', profiles)).rejects.toMatchObject({
      code: 'usage.invalidProjectProfile',
    });
    expect(await readBytes(agentsDir)).toEqual(before);
  });
});

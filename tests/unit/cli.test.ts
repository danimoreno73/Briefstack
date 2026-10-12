import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { PACKAGE_ROOT, VERSION } from '../../src/index.js';
import { specInput, tempDir, writeTree } from '../helpers.js';

interface Captured {
  io: CliIO;
  out: string[];
  err: string[];
}

function capture(dir: string, env: Record<string, string> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      cwd: dir,
      // Never the real repo: `usage set` rewrites <repoDir>/.claude/agents.
      repoDir: path.join(dir, 'repo'),
      pathEnv: {
        env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: 'en', ...env },
        homedir: path.join(dir, 'user'),
        pathApi: path,
        caseInsensitive: process.platform !== 'linux',
      },
    },
  };
}

describe('cli', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli'));
  });
  afterEach(() => cleanup());

  it('reports the package version', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);

    const run = capture(dir);
    expect(await main(['--version'], run.io)).toBe(0);
    expect(run.out).toEqual([`briefstack ${VERSION}`]);
  });

  it('prints usage in the chosen language', async () => {
    const en = capture(dir);
    expect(await main([], en.io)).toBe(0);
    expect(en.out.join('\n')).toContain('Usage: briefstack');

    const es = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['--help'], es.io)).toBe(0);
    expect(es.out.join('\n')).toContain('Uso: briefstack');
  });

  it('refuses Windows path arguments without a drive before touching the disk', async () => {
    // Injects path.win32 so this also covers Windows on a POSIX machine.
    const run = capture(dir);
    run.io.pathEnv = { ...run.io.pathEnv, pathApi: path.win32 };
    run.io.cwd = 'C:\\work';
    for (const args of [
      ['validate', '/c/Users/someone/project'],
      ['scaffold', 'spec.json', '/c/Users/someone/out'],
      ['scaffold', '\\spec.json', 'C:\\out'],
      ['usage', 'set', 'max', '--project', '/c/x'],
    ]) {
      expect(await main(args, run.io), args.join(' ')).toBe(2);
    }
    expect(run.err).toHaveLength(4);
    expect(run.err.every((line) => line.includes('has no drive letter'))).toBe(true);
  });

  it('exits 2 on usage errors', async () => {
    const run = capture(dir);
    expect(await main(['nope'], run.io)).toBe(2);
    expect(await main(['scaffold', 'only-one'], run.io)).toBe(2);
    expect(await main(['scaffold', 'a', 'b', '--force'], run.io)).toBe(2);
    expect(run.err).toEqual([
      'Unknown command: nope',
      expect.stringContaining('Wrong arguments'),
      'Unknown option: --force',
    ]);
  });

  it('scaffolds from a spec file using personal templates', async () => {
    const library = path.join(dir, 'library');
    await writeTree(path.join(library, 'templates'), {
      'generic/common/CLAUDE.md': '# {{name}}\n',
    });
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(specInput()), 'utf8');

    const run = capture(dir, { BRIEFSTACK_LIBRARY: library });
    expect(await main(['scaffold', 'spec.json', 'out'], run.io)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out[0]).toMatch(/^Created \d+ files in .*out \(template: generic\)\.$/);
    // No agents in this spec, so no profile line.
    expect(run.out.some((line) => line.startsWith('Applied usage profile'))).toBe(false);
    expect(await readFile(path.join(dir, 'out', 'CLAUDE.md'), 'utf8')).toBe('# Garden planner\n');
    expect((await stat(path.join(dir, 'out', '.git'))).isDirectory()).toBe(true);
  });

  it('checks a spec without writing anything', async () => {
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(specInput()), 'utf8');
    const ok = capture(dir);
    expect(await main(['spec', 'check', 'spec.json'], ok.io)).toBe(0);
    expect(ok.out).toEqual(['Valid spec: Garden planner (garden-planner), template generic, target claude-code, profile balanced.']);
    expect(await readdir(dir)).toEqual(['spec.json']);

    const failures: [Record<string, unknown>, string][] = [
      [{ slug: 'Bad Slug' }, 'is not valid'],
      [{ profile: 'turbo' }, 'Unknown usage profile "turbo"'],
      [{ template: 'no-such-template' }, 'no-such-template'],
    ];
    for (const [override, text] of failures) {
      await writeFile(path.join(dir, 'bad.json'), JSON.stringify(specInput(override)), 'utf8');
      const run = capture(dir);
      expect(await main(['spec', 'check', 'bad.json'], run.io), text).toBe(1);
      expect(run.err.join('\n')).toContain(text);
    }

    const usage = capture(dir);
    expect(await main(['spec', 'check'], usage.io)).toBe(2);
    expect(await main(['spec', 'validate', 'spec.json'], usage.io)).toBe(2);
  });

  it('explains an invalid spec in Spanish', async () => {
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(specInput({ slug: 'Bad Slug' })), 'utf8');
    const run = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['scaffold', 'spec.json', 'out'], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('no es válida');
    expect(run.err.join('\n')).toContain('slug: usa minúsculas');
  });

  it('refuses to scaffold into the library', async () => {
    const library = path.join(dir, 'library');
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(specInput()), 'utf8');
    const run = capture(dir, { BRIEFSTACK_LIBRARY: library });
    expect(await main(['scaffold', 'spec.json', path.join(library, 'x')], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('personal library');
  });

  describe('validate', () => {
    async function makeProject(files: Record<string, string> = {}): Promise<string> {
      const root = path.join(dir, 'project');
      await writeTree(root, {
        'docs/BRIEF.md': '# Brief\n',
        '.gitignore': '.env\n',
        '.briefstack/profile.json': '{}\n',
        '.briefstack/spec.json': JSON.stringify(specInput({ target: 'claude-app' })),
        'INSTRUCTIONS.md': 'Instructions.\n',
        'NEXT_STEPS.md': 'Steps.\n',
        ...files,
      });
      await mkdir(path.join(root, '.git'));
      return root;
    }

    it('exits 0 and says so for a clean project', async () => {
      await makeProject();
      const run = capture(dir);
      expect(await main(['validate', 'project'], run.io)).toBe(0);
      expect(run.out).toEqual([`${path.join(dir, 'project')}: no problems found.`]);
      expect(run.err).toEqual([]);
    });

    it('exits 1 and lists findings with a summary', async () => {
      await makeProject({ 'NEXT_STEPS.md': '', 'docs/BRIEF.md': '# Brief\n\n[[Nowhere]]\n' });
      const run = capture(dir);
      expect(await main(['validate', 'project'], run.io)).toBe(1);
      expect(run.out).toEqual([
        'error   NEXT_STEPS.md  Required file is empty.',
        'error   docs/BRIEF.md:3  [[Nowhere]] does not match any note in the project.',
        `${path.join(dir, 'project')}: 2 errors, 0 warnings.`,
      ]);
    });

    it('exits 0 when there are only warnings', async () => {
      await makeProject({ '.claude/skills/empty/notes.md': 'x\n' });
      const run = capture(dir);
      expect(await main(['validate', 'project'], run.io)).toBe(0);
      expect(run.out.at(-1)).toMatch(/0 errors, 1 warning\.$/);
    });

    it('prints raw findings as JSON', async () => {
      await makeProject({ 'NEXT_STEPS.md': '' });
      const run = capture(dir);
      expect(await main(['validate', 'project', '--json'], run.io)).toBe(1);
      expect(JSON.parse(run.out.join('\n'))).toEqual({
        projectDir: path.join(dir, 'project'),
        target: 'claude-app',
        errors: 1,
        warnings: 0,
        findings: [{ rule: 'required.empty', severity: 'error', file: 'NEXT_STEPS.md', params: {} }],
      });
    });

    it('speaks Spanish', async () => {
      await makeProject({ 'NEXT_STEPS.md': '' });
      const run = capture(dir, { BRIEFSTACK_LANG: 'es' });
      expect(await main(['validate', 'project'], run.io)).toBe(1);
      expect(run.out).toEqual([
        'error   NEXT_STEPS.md  Un archivo obligatorio está vacío.',
        `${path.join(dir, 'project')}: 1 error, 0 avisos.`,
      ]);
    });

    it('reports a missing folder and wrong arguments', async () => {
      const run = capture(dir);
      expect(await main(['validate', 'missing'], run.io)).toBe(1);
      expect(await main(['validate'], run.io)).toBe(2);
      expect(await main(['validate', 'a', '--fix'], run.io)).toBe(2);
      expect(run.err).toEqual([
        `Project folder not found: ${path.join(dir, 'missing')}`,
        'Wrong arguments. Usage: briefstack validate <project-dir> [--json]',
        'Unknown option: --fix',
      ]);
    });
  });
});

describe('cli usage', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  const realAgents = path.join(PACKAGE_ROOT, '.claude', 'agents');
  const readAll = async (agentsDir: string) => {
    const files: Record<string, string> = {};
    for (const file of (await readdir(agentsDir)).sort()) {
      files[file] = await readFile(path.join(agentsDir, file), 'utf8');
    }
    return files;
  };
  let realBefore: Record<string, string>;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli-usage'));
    await cp(realAgents, path.join(dir, 'repo', '.claude', 'agents'), { recursive: true });
    realBefore = await readAll(realAgents);
  });
  afterEach(async () => {
    // The real repo agent files must never change.
    expect(await readAll(realAgents)).toEqual(realBefore);
    await cleanup();
  });

  it('shows the default profile', async () => {
    const run = capture(dir);
    expect(await main(['usage', 'show'], run.io)).toBe(0);
    const out = run.out.join('\n');
    expect(out).toContain('Active profile: balanced (Balanced');
    expect(out).toContain('this is the default');
    expect(out).toContain('/model sonnet');
    expect(out).toMatch(/architect\s+opus\s+effort medium/);
    expect(out).toContain('Review rounds: at most 2');
    expect(out).toContain('Available profiles: saver, balanced, max');
    expect(out).toContain('/usage');
    expect(run.err).toEqual([]);
  });

  it('shows the active profile as JSON for the skill', async () => {
    const run = capture(dir, { CLAUDE_CODE_EFFORT_LEVEL: 'low' });
    expect(await main(['usage', 'show', '--json'], run.io)).toBe(0);
    expect(run.err).toEqual([]);
    const shown = JSON.parse(run.out.join('\n')) as Record<string, unknown>;
    expect(shown).toMatchObject({
      profile: 'balanced',
      fromConfig: false,
      sessionModel: 'sonnet',
      research: 'when-useful',
      reviewRounds: 2,
      available: ['saver', 'balanced', 'max'],
      drift: [],
      envWarnings: [{ field: 'effort', variable: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'low' }],
    });
    expect((shown.agents as Record<string, unknown>).architect).toEqual({ model: 'opus', effort: 'medium' });

    const saver = capture(dir);
    expect(await main(['usage', 'set', 'saver'], saver.io)).toBe(0);
    const after = capture(dir);
    expect(await main(['usage', 'show', '--json'], after.io)).toBe(0);
    expect(JSON.parse(after.out.join('\n'))).toMatchObject({
      profile: 'saver',
      fromConfig: true,
      research: 'required-only',
      reviewRounds: 1,
    });
  });

  it('warns about overriding environment variables', async () => {
    const run = capture(dir, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_EFFORT_LEVEL: 'low' });
    expect(await main(['usage', 'show'], run.io)).toBe(0);
    expect(run.err).toEqual([
      expect.stringContaining('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1'),
      expect.stringContaining('CLAUDE_CODE_EFFORT_LEVEL=low'),
    ]);
  });

  it('sets a profile on the repo agents and saves it as active', async () => {
    const run = capture(dir);
    expect(await main(['usage', 'set', 'max'], run.io)).toBe(0);
    expect(run.out).toEqual([
      'Applied profile "max".',
      'Changed: architect.md, generator.md, interviewer.md, researcher.md, reviewer.md',
      'Saved "max" as the active profile.',
      expect.stringContaining('/model opus'),
      expect.stringContaining('Do not commit'),
    ]);
    const reviewer = await readFile(path.join(dir, 'repo', '.claude', 'agents', 'reviewer.md'), 'utf8');
    expect(reviewer).toContain('model: opus\neffort: high\n');
    const config = JSON.parse(await readFile(path.join(dir, 'home', 'config.json'), 'utf8')) as unknown;
    expect(config).toEqual({ activeProfile: 'max' });

    const show = capture(dir, { BRIEFSTACK_LANG: 'es' });
    expect(await main(['usage', 'show'], show.io)).toBe(0);
    expect(show.out[0]).toBe('Perfil activo: max (Máximo: el mayor consumo, lo más exhaustivo)');
  });

  it('uses a custom user preset', async () => {
    const custom = {
      label: { en: 'Mine', es: 'Mío' },
      sessionModel: 'inherit',
      effort: 'low',
      agents: { interviewer: 'haiku', researcher: 'haiku', architect: 'haiku', generator: 'haiku', reviewer: 'haiku' },
      tiers: { light: 'haiku', standard: 'haiku', heavy: 'haiku' },
      research: 'required-only',
      reviewRounds: 1,
    };
    await writeTree(path.join(dir, 'home'), {
      'usage-profiles.json': JSON.stringify({ profiles: { mine: custom } }),
    });
    const run = capture(dir);
    expect(await main(['usage', 'set', 'mine'], run.io)).toBe(0);
    const architect = await readFile(path.join(dir, 'repo', '.claude', 'agents', 'architect.md'), 'utf8');
    expect(architect).toContain('model: haiku\neffort: low\n');
  });

  it('rejects an unknown profile without changing anything', async () => {
    const run = capture(dir);
    expect(await main(['usage', 'set', 'turbo'], run.io)).toBe(1);
    expect(run.err).toEqual(['Unknown usage profile "turbo". Available: saver, balanced, max.']);
    await expect(stat(path.join(dir, 'home', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies a profile to a generated project only', async () => {
    const spec = specInput({
      agents: [{ name: 'checker', description: 'Checks things', tools: ['Read'], tier: 'heavy' }],
    });
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec), 'utf8');
    const library = path.join(dir, 'library');
    await writeTree(path.join(library, 'templates'), { 'generic/common/CLAUDE.md': '# {{name}}\n' });
    const made = capture(dir, { BRIEFSTACK_LIBRARY: library });
    expect(await main(['scaffold', 'spec.json', 'proj'], made.io)).toBe(0);
    expect(made.out).toContain('Applied usage profile "balanced" to the generated agents.');

    const run = capture(dir);
    expect(await main(['usage', 'set', 'saver', '--project', 'proj'], run.io)).toBe(0);
    expect(run.out[0]).toContain('moved from profile "balanced" to "saver"');
    const checker = await readFile(path.join(dir, 'proj', '.claude', 'agents', 'checker.md'), 'utf8');
    expect(checker).toContain('model: sonnet\neffort: low\n');
    await expect(stat(path.join(dir, 'home', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(dir, 'repo', '.claude', 'agents', 'reviewer.md'), 'utf8')).toBe(
      realBefore['reviewer.md'],
    );
  });

  it('refuses --project on a folder briefstack did not create', async () => {
    await writeTree(path.join(dir, 'foreign'), { 'README.md': 'x' });
    const run = capture(dir);
    expect(await main(['usage', 'set', 'max', '--project=foreign'], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('was not created by briefstack');
  });

  it('exits 2 on usage errors', async () => {
    const run = capture(dir);
    expect(await main(['usage'], run.io)).toBe(2);
    expect(await main(['usage', 'show', 'extra'], run.io)).toBe(2);
    expect(await main(['usage', 'show', '--yaml'], run.io)).toBe(2);
    expect(await main(['usage', 'set'], run.io)).toBe(2);
    expect(await main(['usage', 'set', 'a', 'b'], run.io)).toBe(2);
    expect(await main(['usage', 'set', 'max', '--project'], run.io)).toBe(2);
    expect(await main(['usage', 'set', 'max', '--force'], run.io)).toBe(2);
    expect(run.err.at(-1)).toBe('Unknown option: --force');
  });
});

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { VERSION } from '../../src/index.js';
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
    expect(await readFile(path.join(dir, 'out', 'CLAUDE.md'), 'utf8')).toBe('# Garden planner\n');
    expect((await stat(path.join(dir, 'out', '.git'))).isDirectory()).toBe(true);
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

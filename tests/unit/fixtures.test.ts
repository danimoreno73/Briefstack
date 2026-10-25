import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemPathEnv, type PathEnv } from '../../src/config/paths.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { scaffold } from '../../src/scaffold/index.js';
import { parseSpec, type Spec, type SpecInput, type Target } from '../../src/spec/index.js';
import {
  CLAUDE_MD_LINE_LIMIT,
  checkSkillFile,
  findAbsolutePaths,
  findSecrets,
  validateProject,
} from '../../src/validate/index.js';
import { baseProfiles, tempDir } from '../helpers.js';

const TEMPLATES = path.join(PACKAGE_ROOT, 'library', 'templates');
const SKILLS = path.join(PACKAGE_ROOT, 'library', 'skills');
const FIXTURES = path.join(PACKAGE_ROOT, 'tests', 'fixtures');

const fakeEnv: PathEnv = {
  env: {},
  homedir: path.join(path.parse(process.cwd()).root, 'fake-home', 'someone'),
  pathApi: path,
  caseInsensitive: process.platform !== 'linux',
};

const FIXTURE_FILES = {
  software: 'software.spec.json',
  learning: 'learning.spec.json',
  novel: 'novel.spec.json',
} as const;

async function readFixture(file: string): Promise<SpecInput> {
  return JSON.parse(await readFile(path.join(FIXTURES, file), 'utf8')) as SpecInput;
}

/** The fixture for a target; skills and agents exist only for `claude-code`. */
function forTarget(input: SpecInput, target: Target): Spec {
  const changed: SpecInput = { ...input, target };
  if (target !== 'claude-code') {
    delete changed.agents;
    delete changed.skills;
  }
  return parseSpec(changed, 'spec.json');
}

/** Every file under `root` except `.git`, relative with `/`. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => file !== '.git' && !file.startsWith('.git/'));
}

const lineCount = (text: string): number => text.replace(/\r?\n$/, '').split(/\r?\n/).length;

describe('base templates', () => {
  it('never glue a list item to the end of the line before it', async () => {
    const files = (await listFiles(TEMPLATES)).filter((file) => file.endsWith('.md'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = await readFile(path.join(TEMPLATES, file), 'utf8');
      expect(text, file).not.toMatch(/[.:)`]- \S/);
    }
  });
});

describe('fixture specs', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('fixtures'));
  });
  afterEach(() => cleanup());

  it('are valid as written and use the base templates', async () => {
    const types: string[] = [];
    for (const file of Object.values(FIXTURE_FILES)) {
      const spec = parseSpec(await readFixture(file), file);
      expect(spec.profile).toBe('balanced');
      types.push(spec.template ?? spec.type);
    }
    expect(types.sort()).toEqual(['generic', 'learning-or-management', 'software']);
  });

  it('the software fixture has an agent and a skill', async () => {
    const spec = parseSpec(await readFixture(FIXTURE_FILES.software), 'software');
    expect(spec.agents.length).toBeGreaterThan(0);
    expect(spec.skills.length).toBeGreaterThan(0);
  });

  for (const [label, file] of Object.entries(FIXTURE_FILES)) {
    for (const target of ['claude-code', 'claude-app'] as const) {
      it(`${label} scaffolds and validates cleanly for ${target}`, async () => {
        const spec = forTarget(await readFixture(file), target);
        const outDir = path.join(dir, spec.slug);
        const result = await scaffold(spec, outDir, {
          protectedDirs: [],
          templateRoots: [TEMPLATES],
          profiles: await baseProfiles(),
        });
        expect(result.templateDir).toBe(path.join(TEMPLATES, spec.template ?? spec.type));

        const validation = await validateProject(outDir, { pathEnv: fakeEnv });
        if (result.gitInitialised) {
          expect(validation.findings).toEqual([]);
        } else {
          // Without git on the machine only the repository check can fail.
          expect(validation.findings).toEqual([
            expect.objectContaining({ rule: 'required.missing', file: '.git', params: { kind: 'gitRepo' } }),
          ]);
        }
        expect(validation.target).toBe(target);

        const files = await listFiles(outDir);
        for (const relative of files) {
          const text = await readFile(path.join(outDir, ...relative.split('/')), 'utf8');
          expect(text, relative).not.toContain('{{');
        }

        if (target === 'claude-code') {
          const claudeMd = await readFile(path.join(outDir, 'CLAUDE.md'), 'utf8');
          expect(lineCount(claudeMd)).toBeLessThan(CLAUDE_MD_LINE_LIMIT);
          // Deny rules do not stop scripts or recursive searches (decisions.md, H9).
          expect(claudeMd).toContain("Keep real secrets (keys, passwords, tokens) out of this folder.");
        } else {
          expect(files).not.toContain('CLAUDE.md');
          const nextSteps = await readFile(path.join(outDir, 'NEXT_STEPS.md'), 'utf8');
          expect(nextSteps).not.toMatch(/cowork/i);
          expect(nextSteps).toContain('Claude desktop app');
          expect(nextSteps).toContain('Scheduled → New task');
          expect(nextSteps).toContain('paid plan');
          expect(nextSteps).toContain('claude.ai');
          for (const task of spec.scheduledTasks) expect(nextSteps).toContain(task.prompt);
        }
      });
    }
  }

  it('keeps CLAUDE.md short even with long lists', async () => {
    const input = await readFixture(FIXTURE_FILES.software);
    const many = (prefix: string) => Array.from({ length: 80 }, (_, i) => `${prefix} ${i + 1}`);
    const spec = parseSpec(
      {
        ...input,
        deliverables: many('Deliverable'),
        constraints: many('Constraint'),
        doneWhen: many('Check'),
        skills: Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i + 1}`, description: 'A skill.' })),
      },
      'spec.json',
    );
    for (const template of ['software', 'learning-or-management', 'generic']) {
      const outDir = path.join(dir, template);
      await scaffold(
        { ...spec, template },
        outDir,
        { protectedDirs: [], templateRoots: [TEMPLATES], profiles: await baseProfiles(), gitInit: false },
      );
      const claudeMd = await readFile(path.join(outDir, 'CLAUDE.md'), 'utf8');
      expect(lineCount(claudeMd), template).toBeLessThan(CLAUDE_MD_LINE_LIMIT);
    }
  });
});

describe('base skills', () => {
  it('ship at least two skills', async () => {
    const entries = await readdir(SKILLS, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).length).toBeGreaterThanOrEqual(2);
  });

  it('each SKILL.md has valid frontmatter, a matching name and no paths or secrets', async () => {
    const entries = await readdir(SKILLS, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const file = `${entry.name}/SKILL.md`;
      const text = await readFile(path.join(SKILLS, entry.name, 'SKILL.md'), 'utf8');
      expect(checkSkillFile(text, file), file).toEqual([]);
      expect(text, file).toMatch(new RegExp(`^---\\r?\\nname: ${entry.name}\\r?\\n`));
      for (const line of text.split(/\r?\n/)) {
        expect(findSecrets(line), `${file}: ${line}`).toEqual([]);
        for (const env of [fakeEnv, systemPathEnv()]) {
          expect(findAbsolutePaths(line, env), `${file}: ${line}`).toEqual([]);
        }
      }
    }
  });
});

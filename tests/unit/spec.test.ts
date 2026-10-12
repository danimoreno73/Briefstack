import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BriefstackError } from '../../src/errors.js';
import {
  isReservedPath,
  isSafeRelativePath,
  parseSpec,
  readSpec,
  specJsonSchema,
  type SpecIssue,
} from '../../src/spec/index.js';
import { specInput, tempDir } from '../helpers.js';

function issuesOf(data: unknown): SpecIssue[] {
  try {
    parseSpec(data, 'spec.json');
  } catch (error) {
    if (error instanceof BriefstackError && error.code === 'spec.invalid') {
      return (error.params as { issues: SpecIssue[] }).issues;
    }
    throw error;
  }
  return [];
}

describe('parseSpec', () => {
  it('accepts a minimal spec and applies defaults', () => {
    const spec = parseSpec(specInput(), 'spec.json');
    expect(spec.constraints).toEqual([]);
    expect(spec.directories).toEqual([]);
    expect(spec.files).toEqual([]);
    expect(spec.skills).toEqual([]);
    expect(spec.agents).toEqual([]);
    expect(spec.scheduledTasks).toEqual([]);
    expect(spec.template).toBeUndefined();
  });

  it('rejects unknown fields and missing required ones with zod messages', () => {
    const issues = issuesOf({ ...specInput(), extra: true, goal: undefined });
    expect(issues.map((issue) => issue.path).sort()).toEqual(['', 'goal']);
    for (const issue of issues) {
      expect(issue.rule).toBeUndefined();
      expect(issue.message).not.toBe('');
    }
  });

  it('flags bad slugs', () => {
    expect(issuesOf(specInput({ slug: 'Garden Planner' }))).toEqual([
      expect.objectContaining({ path: 'slug', rule: 'slug' }),
    ]);
  });

  it('flags unsafe and reserved paths', () => {
    const issues = issuesOf(
      specInput({
        directories: ['../outside', 'notes/'],
        files: [
          { path: 'docs\\a.md', purpose: 'x' },
          { path: '.claude/settings.json', purpose: 'x' },
          { path: 'CON.md', purpose: 'x' },
        ],
      }),
    );
    expect(issues).toEqual([
      expect.objectContaining({ path: 'directories.0', rule: 'safePath' }),
      expect.objectContaining({ path: 'directories.1', rule: 'safePath' }),
      expect.objectContaining({ path: 'files.0.path', rule: 'safePath' }),
      expect.objectContaining({ path: 'files.1.path', rule: 'reservedPath' }),
      expect.objectContaining({ path: 'files.2.path', rule: 'safePath' }),
    ]);
  });

  it('refuses agents that can launch agents, and bad tool names', () => {
    const issues = issuesOf(
      specInput({
        agents: [
          {
            name: 'helper',
            description: 'Helps',
            tier: 'light',
            tools: ['Read', 'Agent', 'Task(x)', 'not a tool', 'Bash(npm test:*)', 'mcp__srv__do'],
          },
        ],
      }),
    );
    expect(issues).toEqual([
      expect.objectContaining({ path: 'agents.0.tools.1', rule: 'noAgentTool' }),
      expect.objectContaining({ path: 'agents.0.tools.2', rule: 'noAgentTool' }),
      expect.objectContaining({ path: 'agents.0.tools.3', rule: 'toolName' }),
    ]);
  });

  it('flags case-insensitive duplicates', () => {
    const issues = issuesOf(
      specInput({
        files: [
          { path: 'Notes.md', purpose: 'a' },
          { path: 'notes.md', purpose: 'b' },
        ],
        skills: [
          { name: 'plan', description: 'a' },
          { name: 'plan', description: 'b' },
        ],
      }),
    );
    expect(issues).toEqual([
      expect.objectContaining({ path: 'files.1', rule: 'duplicate' }),
      expect.objectContaining({ path: 'skills.1', rule: 'duplicate' }),
    ]);
  });

  it('allows skills and agents only for claude-code', () => {
    const issues = issuesOf(
      specInput({
        target: 'claude-app',
        skills: [{ name: 'plan', description: 'a' }],
        agents: [{ name: 'helper', description: 'a', tools: ['Read'], tier: 'light' }],
      }),
    );
    expect(issues).toEqual([
      expect.objectContaining({ path: 'skills', rule: 'claudeCodeOnly' }),
      expect.objectContaining({ path: 'agents', rule: 'claudeCodeOnly' }),
    ]);
  });
});

describe('path rules', () => {
  it('accepts portable relative paths only', () => {
    for (const ok of ['a', 'docs/notes.md', '.github/workflows/ci.yml', 'a b/c-d_e.txt']) {
      expect(isSafeRelativePath(ok)).toBe(true);
    }
    for (const bad of ['', '/abs', 'C:/x', 'a//b', './a', 'a/../b', 'a\\b', 'nul', 'lpt1.txt', 'x.', 'x ', 'a?b']) {
      expect(isSafeRelativePath(bad)).toBe(false);
    }
  });

  it('reserves paths the scaffolder writes', () => {
    for (const reserved of ['.git/config', '.briefstack/x', '.gitignore', '.claude/agents/a.md', '.CLAUDE/Settings.json']) {
      expect(isReservedPath(reserved)).toBe(true);
    }
    for (const free of ['.claude/commands/x.md', 'docs/.gitignore-notes.md', 'CLAUDE.md']) {
      expect(isReservedPath(free)).toBe(false);
    }
  });
});

describe('readSpec', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('spec'));
  });
  afterEach(() => cleanup());

  it('reads a file, tolerating a BOM', async () => {
    const file = path.join(dir, 'spec.json');
    await writeFile(file, `\uFEFF${JSON.stringify(specInput())}`, 'utf8');
    expect((await readSpec(file)).slug).toBe('garden-planner');
  });

  it('reports missing files and bad JSON', async () => {
    await expect(readSpec(path.join(dir, 'missing.json'))).rejects.toMatchObject({
      code: 'spec.notFound',
    });
    const file = path.join(dir, 'bad.json');
    await writeFile(file, '{', 'utf8');
    await expect(readSpec(file)).rejects.toMatchObject({ code: 'spec.invalidJson' });
  });
});

describe('JSON Schema', () => {
  it('matches the committed schemas/spec.schema.json (run npm run schema)', async () => {
    const committed = await readFile(new URL('../../schemas/spec.schema.json', import.meta.url), 'utf8');
    expect(JSON.parse(committed)).toEqual(specJsonSchema());
  });

  it('describes the input shape', () => {
    const schema = specJsonSchema() as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain('slug');
    expect(schema.required).not.toContain('constraints');
    expect(Object.keys(schema.properties)).toContain('scheduledTasks');
  });
});

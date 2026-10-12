import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, DENY_RULES, isReadDenied, readRuleDenies } from '../../src/scaffold/index.js';
import { parseSpec } from '../../src/spec/index.js';
import { specInput, tempDir } from '../helpers.js';

const execFileAsync = promisify(execFile);

const READABLE = ['.env.example', '.env.sample', '.env.template', 'config/.env.example', 'README.md', 'env.md'];
const DENIED = [
  '.env',
  'app/.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '.env.production.local',
  'web/.env.development.local',
  'certs/server.pem',
  'id.key',
];

describe('deny rules', () => {
  it('keep .env.example and .env.sample readable', () => {
    for (const file of READABLE) expect(isReadDenied(file), file).toBe(false);
  });

  it('deny .env files with real values and key material', () => {
    for (const file of DENIED) expect(isReadDenied(file), file).toBe(true);
  });

  it('never use a catch-all .env.* pattern', () => {
    expect(DENY_RULES).not.toContain('Read(.env.*)');
  });

  it('do not apply home or absolute rules to project paths', () => {
    expect(readRuleDenies('Read(~/.npmrc)', '.npmrc')).toBe(false);
    expect(readRuleDenies('Read(//**/.env)', '.env')).toBe(false);
  });
});

describe('generated .gitignore', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('gitignore'));
  });
  afterEach(() => cleanup());

  it('ignores the same secret files and keeps .env.example tracked (checked with git)', async () => {
    const plan = buildPlan(parseSpec(specInput(), 'spec.json'), { name: 't', dir: 'unused', files: [] });
    const gitignore = plan.files.find((file) => file.path === '.gitignore')?.content ?? '';
    await execFileAsync('git', ['init', '--quiet'], { cwd: dir });
    await writeFile(path.join(dir, '.gitignore'), gitignore, 'utf8');

    const ignored = async (file: string) => {
      try {
        await execFileAsync('git', ['check-ignore', '--quiet', '--no-index', file], { cwd: dir });
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) return false;
        throw error;
      }
    };
    for (const file of READABLE) expect(await ignored(file), file).toBe(false);
    for (const file of DENIED) expect(await ignored(file), file).toBe(true);
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAsset } from '../../src/improve/allowlist.js';
import { parseLockedBlocks } from '../../src/improve/locked.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';

/** The security-relevant instructions each file keeps locked (BRIEF-phase-5 §3.1), and a phrase each block must hold. */
const EXPECTED: Record<string, Record<string, string>> = {
  '.claude/skills/new-project/SKILL.md': {
    'cli-and-paths': 'one command per Bash call',
    'working-files': 'Never write in the briefstack repo or in the personal library',
    'denied-calls': 'When a tool call is denied',
    'web-answers': 'never end a turn waiting for an answer in plain text',
    'spec-web': 'Never ask in plain text and never end the turn instead',
    'spec-checkpoint': 'Nothing is created before the user approves',
    'notes-no-secrets': 'never hold secrets, credentials or sensitive personal data',
  },
  '.claude/agents/generator.md': {
    'generator-scope': 'Write only inside the output folder',
    'generator-no-secrets': 'No secrets, no absolute paths',
    'generator-denied': 'If a write in the output folder is denied',
  },
  '.claude/agents/architect.md': { 'architect-safety': 'No secrets and no absolute paths in the spec' },
  '.claude/agents/interviewer.md': { 'interviewer-secrets': 'Do not ask for passwords, keys or other secrets' },
  '.claude/agents/reviewer.md': { 'reviewer-safety': 'No hooks' },
};

const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('locked blocks in the creation flow', () => {
  for (const [file, blocks] of Object.entries(EXPECTED)) {
    it(`${file} keeps its locked blocks`, async () => {
      expect(classifyAsset(file)?.bodyOnly).toBe(true);
      const parsed = parseLockedBlocks(await readFile(path.join(PACKAGE_ROOT, ...file.split('/')), 'utf8'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.blocks.map((block) => block.id).sort()).toEqual(Object.keys(blocks).sort());
      for (const block of parsed.blocks) expect(flat(block.text), block.id).toContain(blocks[block.id]);
    });
  }
});

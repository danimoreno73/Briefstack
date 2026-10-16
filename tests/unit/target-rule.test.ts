import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { TARGET_CHOOSERS } from '../../src/spec/schema.js';

const RULE = 'library/rules/target.md';
const read = (...parts: string[]) => readFile(path.join(PACKAGE_ROOT, ...parts), 'utf8');

/**
 * The target is chosen by one rule that both the interviewer and the
 * architect read (BRIEF-phase-3, P1). The agents are prose for the model;
 * what keeps them on the same rule is pinned here.
 */
describe('the target rule', () => {
  it('lives in one base library file with both targets, mixed ideas and who chose', async () => {
    const text = await read('library', 'rules', 'target.md');
    expect(text).toContain('**`claude-app`** when the value is mainly conversation, learning or ongoing\n  personal management');
    expect(text).toContain('**`claude-code`** when the work is mainly files an agent edits and can\n  verify');
    expect(text).toContain('**Mixed ideas**');
    expect(text).toContain('recommend the one that serves the **main value**');
    for (const who of TARGET_CHOOSERS) expect(text).toContain(`- \`${who}\`:`);
    expect(text).toContain('`targetChosenBy`');
  });

  it('is read and cited by the interviewer and the architect, which hold no rule of their own', async () => {
    for (const agent of ['interviewer', 'architect']) {
      const text = await read('.claude', 'agents', `${agent}.md`);
      expect(text, agent).toContain(`\`${RULE}\``);
      expect(text, agent).not.toContain('mainly conversation, learning or ongoing');
    }
    const architect = await read('.claude', 'agents', 'architect.md');
    expect(architect).toContain('set `targetChosenBy` to `user`');
    expect(architect).toContain('set `targetChosenBy` to `architect`');
    // Nothing else reads the rule from a different place.
    const interviewer = await read('.claude', 'agents', 'interviewer.md');
    expect(interviewer).toContain('Always read\n   `library/rules/target.md`');
  });

  it('keeps the agent frontmatter as usage set writes it', async () => {
    for (const agent of ['interviewer', 'architect']) {
      const file = path.join(PACKAGE_ROOT, '.claude', 'agents', `${agent}.md`);
      const { data } = parseFrontmatter(await readFile(file, 'utf8'), file);
      expect(Object.keys(data).sort(), agent).toEqual(['description', 'effort', 'model', 'name', 'tools']);
    }
  });

  it('is shown to the user before approval: the skill names who chose', async () => {
    const skill = await read('.claude', 'skills', 'new-project', 'SKILL.md');
    expect(skill).toContain('the target with who chose it (the user, or the architect by\n   `library/rules/target.md`)');
  });
});

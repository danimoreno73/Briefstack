import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOW_STEPS, SESSION_OUTCOMES } from '../../src/events/index.js';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';

const SKILL = path.join(PACKAGE_ROOT, '.claude', 'skills', 'new-project', 'SKILL.md');

/**
 * The skill is prose for the model, but a few parts of it are a contract with
 * the CLI and the hooks (decisions.md, H8/H9). Pin those.
 */
describe('/new-project skill', () => {
  it('runs in the main session and only when the user invokes it', async () => {
    const { hasFrontmatter, data } = parseFrontmatter(await readFile(SKILL, 'utf8'), SKILL);
    expect(hasFrontmatter).toBe(true);
    expect(data.name).toBe('new-project');
    expect(typeof data.description).toBe('string');
    expect(data['disable-model-invocation']).toBe(true);
    // `context: fork` would run it in a subagent, which cannot ask the user.
    expect(data.context).toBeUndefined();
    expect(data.hooks).toBeUndefined();
  });

  it('opens the session first and closes it with every outcome', async () => {
    const text = await readFile(SKILL, 'utf8');
    const open = 'npm run --silent briefstack -- event session started --session SESSION';
    expect(text).toContain('`SESSION` below is `${CLAUDE_SESSION_ID}`');
    const firstCommand = text.indexOf('npm run --silent briefstack -- ', text.indexOf('## 0. Start'));
    expect(text.indexOf(open, firstCommand)).toBe(firstCommand);
    expect(text).toContain('event session finished --session SESSION --outcome <outcome>');
    for (const outcome of SESSION_OUTCOMES) expect(text).toContain(`\`${outcome}\``);
  });

  it('names every flow step the events module knows, in order', async () => {
    const text = await readFile(SKILL, 'utf8');
    const listed = text.match(/Steps, in order: (.+?)\./s)?.[1] ?? '';
    expect(listed.replace(/\s+/g, ' ').match(/`[a-z-]+`/g)).toEqual(FLOW_STEPS.map((step) => `\`${step}\``));
    for (const step of FLOW_STEPS) expect(text).toContain(`Step \`${step}\``);
  });

  it('never passes model or effort to agents and uses only the allowed CLI form', async () => {
    const text = await readFile(SKILL, 'utf8');
    expect(text).toContain('Never\n  pass `model` or `effort`');
    // Every CLI call in the skill uses the prefix the repo allow rule covers,
    // except `init`, which the user runs in their own terminal.
    const all = text.match(/briefstack -- [a-z]+/g) ?? [];
    const allowed = text.match(/npm run --silent briefstack -- [a-z]+/g) ?? [];
    expect(allowed.length).toBeGreaterThanOrEqual(8);
    expect(text.match(/npm run briefstack -- init/g)).toHaveLength(1);
    expect(all).toHaveLength(allowed.length + 1);
    expect(text).not.toMatch(/npm run --silent briefstack[^`\n]*(&&|\|)/);
  });
});

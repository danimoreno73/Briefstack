import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchSubcommand } from '../../src/creation/guard.js';
import { FLOW_STEPS } from '../../src/events/index.js';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';

const SKILL = path.join(PACKAGE_ROOT, '.claude', 'skills', 'new-project', 'SKILL.md');
const AGENTS = path.join(PACKAGE_ROOT, '.claude', 'agents');

/**
 * The skill has one flow. Two answers have two sources, the terminal and the
 * web app; /new-project from the terminal must behave exactly as before.
 */
describe('/new-project in the terminal and in the web app', () => {
  it('has both sources for the two answers that differ', async () => {
    const text = await readFile(SKILL, 'utf8');
    expect(text).toContain('approve_spec');
    expect(text).toContain('grant_directory');
    expect(text).toContain('briefstack-web');
  });

  it('decides the mode once, and in the web app asks for the spec only through approve_spec', async () => {
    const text = (await readFile(SKILL, 'utf8')).replace(/\s+/g, ' ');
    expect(text).toContain('Set `MODE`');
    expect(text).toContain('in `MODE` web never end a turn waiting for an answer in plain text');
    const spec = text.slice(text.indexOf('## 5. Spec'), text.indexOf('## 6. Generate'));
    const web = spec.indexOf('**Web app** (`MODE` web)');
    const terminal = spec.indexOf('**Terminal** (`MODE` terminal)');
    // The web branch comes first, and the plain-text question only under the terminal one.
    expect(web).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(web);
    expect(spec.indexOf('Ask them to approve, change something or cancel.')).toBeGreaterThan(terminal);
    expect(spec).toContain('Never ask in plain text and never end the turn instead.');
  });

  it('keeps the terminal text exactly as it was', async () => {
    const text = (await readFile(SKILL, 'utf8')).replace(/\s+/g, ' ');
    for (const sentence of [
      'Ask them to approve, change something or cancel.',
      'ask the user to run `/add-dir <dir>` themselves',
      'create the folder first (`/add-dir` refuses a missing folder), for example with `! mkdir "<dir>"`',
      'Wait until they say it is done, then treat the folder as allowed',
      '`/add-dir` lasts for this session only and `paths check` cannot see it, so do not check `allowed` again',
      'ask the user to run `/add-dir <dir>`',
    ]) {
      expect(text, sentence).toContain(sentence);
    }
  });

  it('does not change the steps or the event calls between the two', async () => {
    const lines = (await readFile(SKILL, 'utf8')).split('\n');
    const blocks: string[] = [];
    lines.forEach((line, index) => {
      if (!line.includes('**Web app**')) return;
      const indent = line.search(/\S/);
      const block = [line];
      for (const next of lines.slice(index + 1)) {
        const nextIndent = next.search(/\S/);
        if (next.trim() === '' || (nextIndent <= indent && /^\s*(-|\d+\.|#)/.test(next))) break;
        block.push(next);
      }
      blocks.push(block.join('\n'));
    });
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).not.toMatch(/briefstack -- event/);
      expect(block).not.toMatch(/Step `/);
      expect(block).not.toMatch(/--outcome/);
    }
    // Each step starts once, and the session opens once in the text.
    const text = lines.join('\n');
    expect(text.match(/event session started --session SESSION/g)).toHaveLength(1);
    for (const step of FLOW_STEPS) expect(text.match(new RegExp(`Step \`${step}\``, 'g')), step).toHaveLength(1);
  });

  it('records the creation session on the project note', async () => {
    const text = (await readFile(SKILL, 'utf8')).replace(/\s+/g, ' ');
    expect(text).toContain('also pass `--session SESSION`');
  });
});

describe('the skill and the agents against the guard', () => {
  const commandsIn = (text: string): string[][] =>
    [...text.matchAll(/npm run --silent briefstack -- ([a-z]+)(?: ([a-z]+))?/g)].map((match) => [
      match[1] as string,
      ...(match[2] === undefined ? [] : [match[2]]),
    ]);

  it('uses only commands the main session may run', async () => {
    const commands = commandsIn(await readFile(SKILL, 'utf8'));
    expect(commands.length).toBeGreaterThan(8);
    for (const command of commands) expect(matchSubcommand('main', command), command.join(' ')).toBeDefined();
  });

  it('gives the generator and the reviewer only what the guard lets them run', async () => {
    for (const [file, caller] of [
      ['generator.md', 'generator'],
      ['reviewer.md', 'reviewer'],
    ] as const) {
      const text = await readFile(path.join(AGENTS, file), 'utf8');
      const commands = commandsIn(text);
      expect(commands.length, file).toBeGreaterThan(0);
      for (const command of commands) expect(matchSubcommand(caller, command), `${file}: ${command.join(' ')}`).toBeDefined();
      expect(text, file).not.toContain('read-only commands');
    }
  });

  it('gives the agents the guard treats as having no shell no shell tool', async () => {
    for (const file of ['interviewer.md', 'researcher.md', 'architect.md']) {
      const { data } = parseFrontmatter(await readFile(path.join(AGENTS, file), 'utf8'), file);
      expect(String(data.tools), file).not.toMatch(/Bash|PowerShell/);
    }
  });
});

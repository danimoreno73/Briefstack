import { describe, expect, it } from 'vitest';
import { classifyAsset, isAllowedAsset, SKILL_FILE } from '../../src/improve/allowlist.js';
import { addedLines, checkProposedText, prepareContext } from '../../src/improve/filters.js';
import { lockedBlockProblems, parseLockedBlocks } from '../../src/improve/locked.js';
import { isPlainText, splitFrontmatter } from '../../src/improve/text.js';

// Built by concatenation so secret scanners do not flag this test file.
const FAKE_SECRET = 'sk-' + 'ant-api03-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';

describe('allowlist', () => {
  it('allows agent and skill bodies and the base library templates and rules', () => {
    expect(classifyAsset('.claude/agents/interviewer.md')).toEqual({ kind: 'agent', bodyOnly: true });
    expect(classifyAsset(SKILL_FILE)).toEqual({ kind: 'skill', bodyOnly: true });
    expect(classifyAsset('library/rules/target.md')).toEqual({ kind: 'library', bodyOnly: false });
    expect(classifyAsset('library/templates/software/common/docs/BRIEF.md')).toEqual({ kind: 'library', bodyOnly: false });
    expect(classifyAsset('library/templates/software/common/.gitignore')).toEqual({ kind: 'library', bodyOnly: false });
  });

  it('refuses everything else', () => {
    for (const path of [
      'src/improve/allowlist.ts',
      'scripts/real/common.ts',
      'tests/unit/x.test.ts',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/agents/sub/x.md',
      '.claude/agents/X.md',
      '.claude/skills/other/SKILL.md',
      '.claude/skills/new-project/extra.md',
      'package.json',
      'package-lock.json',
      '.github/workflows/ci.yml',
      'docs/BRIEF-phase-5.md',
      'CLAUDE.md',
      'library/usage-profiles.json',
      'library/skills/decision-log/SKILL.md',
      'library/templates/../../src/x.ts',
      'library/templates/a/.git/config',
      'library/templates/a/.claude/settings.json',
      'library/templates/a//b.md',
      'library\\rules\\target.md',
      '/library/rules/target.md',
      'C:/repo/library/rules/target.md',
      '',
    ]) {
      expect(isAllowedAsset(path), path).toBe(false);
    }
  });
});

describe('splitFrontmatter', () => {
  it('splits byte for byte and joins back', () => {
    const text = '---\nname: a\nmodel: opus\n---\n\nBody line.\n';
    const { head, body } = splitFrontmatter(text);
    expect(head).toBe('---\nname: a\nmodel: opus\n---\n');
    expect(body).toBe('\nBody line.\n');
    expect(head + body).toBe(text);
  });

  it('keeps CRLF and a file without frontmatter', () => {
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nx\r\n')).toEqual({ head: '---\r\na: 1\r\n---\r\n', body: 'x\r\n' });
    expect(splitFrontmatter('# Title\n')).toEqual({ head: '', body: '# Title\n' });
    const bom = String.fromCharCode(0xfeff);
    expect(splitFrontmatter(`${bom}---\na: 1\n---\nx\n`)).toEqual({ head: `${bom}---\na: 1\n---\n`, body: 'x\n' });
    expect(splitFrontmatter('FEFF---\na: 1\n---\nx\n').head).toBe('');
  });

  it('tells text from binary', () => {
    expect(isPlainText(new TextEncoder().encode('héllo'))).toBe(true);
    expect(isPlainText(new Uint8Array([104, 0, 105]))).toBe(false);
    expect(isPlainText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });
});

const LOCKED = [
  '# Skill',
  '',
  '## Web mode',
  '',
  '<!-- briefstack:locked web-mode -->',
  'Never ask in text in web mode.',
  '<!-- /briefstack:locked web-mode -->',
  '',
  'Free text here.',
  '',
  '## Denied calls',
  '',
  '<!-- briefstack:locked denied -->',
  'Do not retry a denied call.',
  '<!-- /briefstack:locked denied -->',
  '',
].join('\n');

describe('locked blocks', () => {
  it('parses blocks with their heading', () => {
    const parsed = parseLockedBlocks(LOCKED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.map((block) => [block.id, block.heading])).toEqual([
      ['web-mode', '## Web mode'],
      ['denied', '## Denied calls'],
    ]);
  });

  it('accepts changes outside the blocks', () => {
    expect(lockedBlockProblems(LOCKED, LOCKED.replace('Free text here.', 'Better free text.'))).toEqual([]);
  });

  it('rejects a changed block', () => {
    expect(lockedBlockProblems(LOCKED, LOCKED.replace('Never ask in text', 'Rarely ask in text'))).toEqual(['locked block "web-mode" was changed']);
  });

  it('rejects a deleted block, also when only its markers go', () => {
    const without = LOCKED.replace(/<!-- briefstack:locked denied -->\nDo not retry a denied call.\n<!-- \/briefstack:locked denied -->\n/, '');
    expect(lockedBlockProblems(LOCKED, without)).toEqual(['locked block "denied" was deleted']);
    const unmarked = LOCKED.replace('<!-- briefstack:locked denied -->\n', '').replace('<!-- /briefstack:locked denied -->\n', '');
    expect(lockedBlockProblems(LOCKED, unmarked)).toEqual(['locked block "denied" was deleted']);
  });

  it('rejects a block moved under another heading or reordered', () => {
    const block = '<!-- briefstack:locked web-mode -->\nNever ask in text in web mode.\n<!-- /briefstack:locked web-mode -->\n';
    const moved = LOCKED.replace(block, '').replace('Do not retry a denied call.\n<!-- /briefstack:locked denied -->\n', `Do not retry a denied call.\n<!-- /briefstack:locked denied -->\n${block}`);
    expect(lockedBlockProblems(LOCKED, moved)).toEqual(['locked block "web-mode" was moved under another heading']);
    const renamed = LOCKED.replace('## Web mode', '## Browser');
    expect(lockedBlockProblems(LOCKED, renamed)).toEqual(['locked block "web-mode" was moved under another heading']);
    const twoUnderOne = '## A\n\n<!-- briefstack:locked a -->\nA\n<!-- /briefstack:locked a -->\n<!-- briefstack:locked b -->\nB\n<!-- /briefstack:locked b -->\n';
    const swapped = '## A\n\n<!-- briefstack:locked b -->\nB\n<!-- /briefstack:locked b -->\n<!-- briefstack:locked a -->\nA\n<!-- /briefstack:locked a -->\n';
    expect(lockedBlockProblems(twoUnderOne, swapped)).toEqual(['locked blocks are in another order']);
  });

  it('rejects a new block and broken markers', () => {
    expect(lockedBlockProblems(LOCKED, `${LOCKED}<!-- briefstack:locked mine -->\nx\n<!-- /briefstack:locked mine -->\n`)).toEqual(['locked block "mine" was added']);
    expect(lockedBlockProblems(LOCKED, LOCKED.replace('<!-- /briefstack:locked denied -->', ''))[0]).toMatch(/not closed/);
    expect(lockedBlockProblems(LOCKED, LOCKED.replace('<!-- /briefstack:locked denied -->', '<!-- /briefstack:locked web-mode -->'))[0]).toMatch(/does not match/);
    expect(lockedBlockProblems(LOCKED, LOCKED.replace('Free text here.', 'briefstack:locked inline'))[0]).toMatch(/looks like a locked-block marker/);
  });
});

describe('filters', () => {
  const context = prepareContext({
    homedir: 'C:\\Users\\alice',
    username: 'alice',
    folders: ['D:\\data\\briefstack-projects'],
    profileTexts: ['# Style\n\nI prefer answers in short bullet lists with no emojis at all.\n'],
  });
  const check = (added: string) => checkProposedText('Line one.\n', `Line one.\n${added}\n`, context);

  it('finds the added lines', () => {
    expect(addedLines('a\nb\nc\n', 'a\nx\nb\nc\ny\n')).toEqual([
      { line: 2, text: 'x' },
      { line: 5, text: 'y' },
    ]);
  });

  it('passes generic text and placeholder paths', () => {
    expect(check('Ask at most three questions, then write the spec.')).toEqual([]);
    expect(check('For example "C:/Users/you/projects/app" or /home/you/app.')).toEqual([]);
    expect(check('Write <home>/library paths as placeholders.')).toEqual([]);
  });

  it('rejects a secret', () => {
    expect(check(`key: ${FAKE_SECRET}`)).toEqual([{ kind: 'secret', line: 2, detail: 'something that looks like a secret' }]);
  });

  it("rejects this machine's paths and other real user folders", () => {
    expect(check('See C:\\Users\\alice\\notes.md.').map((p) => p.kind)).toEqual(['personalPath']);
    expect(check('See c:/users/ALICE/notes.md.').map((p) => p.kind)).toEqual(['personalPath']);
    expect(check('Output in D:/data/briefstack-projects/app.').map((p) => p.kind)).toEqual(['personalPath']);
    expect(check('Like /home/bob/project.').map((p) => p.kind)).toEqual(['personalPath']);
    expect(check('Like /Users/carol/project.').map((p) => p.kind)).toEqual(['personalPath']);
    expect(check('Under E:/work/alice/x.').map((p) => p.kind)).toEqual(['personalPath']);
  });

  it('rejects text copied from the profile', () => {
    expect(check('I prefer answers in short bullet lists with no emojis at all.').map((p) => p.kind)).toEqual(['profileText']);
    expect(check('- Note: prefer answers in short bullet lists with no emojis, always.').map((p) => p.kind)).toEqual(['profileText']);
    expect(check('Prefer short answers.')).toEqual([]);
  });

  it('ignores lines the base already had', () => {
    const base = `Line one.\nSee C:\\Users\\alice\\notes.md.\n`;
    expect(checkProposedText(base, `${base}New generic line.\n`, context)).toEqual([]);
  });

  describe('personal data', () => {
    const personal = prepareContext({
      homedir: 'C:\\Users\\alice',
      username: 'alice',
      folders: [],
      profileTexts: [],
      gitName: 'Alice Liddell',
      gitEmail: 'alice.l@wonder.io',
      projectNames: ['meal-planner', 'Garden Journal', 'app'],
      lessonTexts: ['# Lessons\n\n- 2026-10-01: The architect wrote the spec before the interviewer had asked about the target platform.\n'],
    });
    const kinds = (added: string) => checkProposedText('Line one.\n', `Line one.\n${added}\n`, personal).map((p) => p.kind);

    it('rejects e-mail addresses, apart from placeholder domains', () => {
      expect(kinds('Write to bob@company.io for help.')).toEqual(['personalData']);
      expect(kinds('Contact: Carol.Smith+x@mail.example-corp.com')).toEqual(['personalData']);
      expect(kinds('Use you@example.com or name@test.example or a@b.invalid.')).toEqual([]);
    });

    it("rejects the git user's name and e-mail", () => {
      expect(kinds('Thanks to alice LIDDELL.')).toEqual(['personalData']);
      expect(kinds('Ask alice.l@wonder.io.')).toEqual(['personalData']);
      expect(kinds('Alice and the liddell scheme are fine apart.')).toEqual([]);
    });

    it("rejects the names of the library's projects, whatever the separators", () => {
      expect(kinds('As in the meal planner project.')).toEqual(['personalData']);
      expect(kinds('See meal-planner/README.md.')).toEqual(['personalData']);
      expect(kinds('Like the garden_journal app.')).toEqual(['personalData']);
      // Names shorter than four letters are too common to tell apart.
      expect(kinds('Plan meals in the app.')).toEqual([]);
    });

    it('rejects paths written from the home folder with ~', () => {
      expect(kinds('Keep notes in ~/notes/app.md.')).toEqual(['personalPath']);
      expect(kinds('Or "~\\notes".')).toEqual(['personalPath']);
      expect(kinds('About ~5 minutes, approx~ish.')).toEqual([]);
    });

    it('rejects eight words in a row copied from the lessons', () => {
      expect(kinds('Remember: the architect wrote the spec before the interviewer had asked.')).toEqual(['lessonText']);
      expect(kinds('The architect writes the spec once the interview ends.')).toEqual([]);
    });
  });
});

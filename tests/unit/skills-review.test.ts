import { describe, expect, it } from 'vitest';
import {
  MAX_FINDINGS,
  detectLicense,
  fileKind,
  identifyLicense,
  readSkillFrontmatter,
  reviewSkill,
  sha256,
  type FindingRule,
  type ReviewFinding,
} from '../../src/skills/review.js';
import { EXFILTRATOR, HARMLESS, INJECTOR, MIT, withSecret, type FixtureFiles } from '../skillFixtures.js';

const files = (map: FixtureFiles) =>
  Object.entries(map).map(([path, value]) => {
    const entry = typeof value === 'string' ? { content: value } : value;
    return { path, bytes: typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content, executable: entry.mode === '100755' };
  });

const rulesIn = (findings: readonly ReviewFinding[], file?: string): Set<FindingRule> =>
  new Set(findings.filter((f) => file === undefined || f.file === file).map((f) => f.rule));

describe('inventory and file kinds', () => {
  it('tells markdown, scripts (by extension, shebang or mode), binaries and other files apart', () => {
    expect(fileKind('a.md', Buffer.from('# x'), false)).toBe('markdown');
    expect(fileKind('run.py', Buffer.from('print(1)'), false)).toBe('script');
    expect(fileKind('tool', Buffer.from('#!/usr/bin/env node\n'), false)).toBe('script');
    expect(fileKind('tool', Buffer.from('plain'), true)).toBe('script');
    expect(fileKind('x.png', Buffer.from([0x89, 0x50, 0x00, 0x47]), false)).toBe('binary');
    expect(fileKind('x.txt', Buffer.from([0xff, 0xfe, 0xfd]), false)).toBe('binary');
    expect(fileKind('helper.exe', Buffer.from('MZ'), false)).toBe('binary');
    expect(fileKind('schema.json', Buffer.from('{}'), false)).toBe('other');
  });

  it('lists every file with its size and SHA-256', () => {
    const review = reviewSkill({ files: files(HARMLESS) });
    expect(review.inventory.map((i) => i.path)).toEqual(['LICENSE', 'SKILL.md', 'guide.md']);
    const skill = review.inventory.find((i) => i.path === 'SKILL.md');
    expect(skill?.sha256).toBe(sha256(Buffer.from(HARMLESS['SKILL.md'] as string)));
    expect(skill?.size).toBe(Buffer.byteLength(HARMLESS['SKILL.md'] as string));
  });
});

describe('frontmatter', () => {
  it('reads name, description, allowed-tools, license, hooks and shell; never throws', () => {
    expect(readSkillFrontmatter('---\nname: a\ndescription: B\nallowed-tools: [Read, Grep]\nlicense: MIT\nshell: powershell\nhooks: {}\n---\nbody')).toMatchObject({
      name: 'a',
      description: 'B',
      allowedTools: 'Read Grep',
      license: 'MIT',
      shell: 'powershell',
      hooks: true,
      parsed: true,
    });
    expect(readSkillFrontmatter('no frontmatter').parsed).toBe(false);
    expect(readSkillFrontmatter('---\n: : [unclosed\n---\n').parsed).toBe(false);
    expect(readSkillFrontmatter('---\n- a\n- b\n---\n').parsed).toBe(false);
  });
});

describe('license detection', () => {
  it('recognises common licenses by their text', () => {
    expect(identifyLicense(MIT)).toBe('MIT');
    expect(identifyLicense('Apache License\nVersion 2.0, January 2004')).toBe('Apache-2.0');
    expect(identifyLicense('GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007')).toBe('GPL-3.0');
    expect(identifyLicense('Redistribution and use in source and binary forms ... Neither the name of')).toBe('BSD-3-Clause');
    expect(identifyLicense('This is free and unencumbered software released into the public domain.')).toBe('Unlicense');
    expect(identifyLicense('All rights reserved. Proprietary.')).toBeNull();
  });

  it('takes a license file first, then the frontmatter, an SPDX header, then the repo root', () => {
    const fm = readSkillFrontmatter('---\nlicense: Apache-2.0\n---\n');
    const none = readSkillFrontmatter('---\ndescription: x\n---\n');
    const md = { path: 'SKILL.md', bytes: Buffer.from('x'), executable: false };
    expect(detectLicense([md, { path: 'LICENSE.txt', bytes: Buffer.from(MIT), executable: false }], fm)).toEqual({ spdx: 'MIT', source: 'file', file: 'LICENSE.txt' });
    expect(detectLicense([md], fm)).toEqual({ spdx: 'Apache-2.0', source: 'frontmatter' });
    expect(detectLicense([md, { path: 'a.py', bytes: Buffer.from('# SPDX-License-Identifier: BSD-2-Clause\n'), executable: false }], none)).toMatchObject({ spdx: 'BSD-2-Clause', source: 'header', file: 'a.py' });
    expect(detectLicense([md], none, { path: 'LICENSE', bytes: Buffer.from(MIT) })).toEqual({ spdx: 'MIT', source: 'repo', file: 'LICENSE' });
    expect(detectLicense([md, { path: 'LICENSE', bytes: Buffer.from('All rights reserved.'), executable: false }], none)).toEqual({ spdx: null, source: 'file', file: 'LICENSE' });
    expect(detectLicense([md], none)).toEqual({ spdx: null, source: 'none' });
  });

  it('a missing license is a medium finding, an unknown one a low one', () => {
    const missing = reviewSkill({ files: files({ 'SKILL.md': '---\ndescription: x\n---\n' }) });
    expect(missing.findings.find((f) => f.rule === 'license')).toMatchObject({ severity: 'medium' });
    const unknown = reviewSkill({ files: files({ 'SKILL.md': '---\ndescription: x\n---\n', LICENSE: 'All rights reserved.' }) });
    expect(unknown.findings.find((f) => f.rule === 'license')).toMatchObject({ severity: 'low', file: 'LICENSE' });
  });
});

describe('static findings', () => {
  it('a harmless skill has nothing above low and no scripts or network', () => {
    const review = reviewSkill({ files: files(HARMLESS) });
    expect(review.findings.filter((f) => f.severity === 'high' || f.severity === 'medium')).toEqual([]);
    expect(review.hasScripts).toBe(false);
    expect(review.network).toBe(false);
    expect(review.license).toMatchObject({ spdx: 'MIT' });
  });

  it('finds scripts, network use, credentials, deletion, writes outside, shell and obfuscation in scripts', () => {
    const review = reviewSkill({ files: files(EXFILTRATOR) });
    expect(review.hasScripts).toBe(true);
    expect(review.network).toBe(true);
    const sh = rulesIn(review.findings, 'scripts/sync.sh');
    for (const rule of ['script', 'network', 'credentials', 'deletion', 'writeOutside', 'obfuscation'] as const) expect(sh, rule).toContain(rule);
    const py = rulesIn(review.findings, 'scripts/steal.py');
    for (const rule of ['script', 'network', 'credentials', 'shell', 'deletion', 'obfuscation'] as const) expect(py, rule).toContain(rule);
    const curl = review.findings.find((f) => f.file === 'scripts/sync.sh' && f.rule === 'credentials');
    expect(curl).toMatchObject({ severity: 'high', line: 2 });
    expect(curl?.excerpt).toContain('id_rsa');
  });

  it('finds text aimed at the agent, render-time commands, hooks, a plugin, settings, allowed-tools and binaries', () => {
    const review = reviewSkill({ files: files(INJECTOR) });
    const md = rulesIn(review.findings, 'SKILL.md');
    for (const rule of ['bypass', 'injectedCommand', 'hooks', 'allowedTools', 'settings', 'appName', 'appDescription', 'credentials'] as const) expect(md, rule).toContain(rule);
    expect(review.findings.find((f) => f.rule === 'allowedTools')?.severity).toBe('high');
    expect(rulesIn(review.findings, '.claude-plugin/plugin.json')).toContain('plugin');
    expect(rulesIn(review.findings, 'hooks/hooks.json')).toContain('hooks');
    expect(rulesIn(review.findings, 'settings.json')).toContain('settings');
    expect(review.findings.find((f) => f.file === 'bin/helper.exe')).toMatchObject({ rule: 'binary', severity: 'high' });
    const bypass = review.findings.filter((f) => f.rule === 'bypass').map((f) => f.line);
    expect(bypass).toEqual(expect.arrayContaining([13, 14]));
    expect(review.hasScripts).toBe(true);
  });

  it('a secret-looking line becomes a finding with the line hidden', () => {
    const review = reviewSkill({ files: files(withSecret()) });
    const secret = review.findings.find((f) => f.rule === 'secret');
    expect(secret).toMatchObject({ severity: 'high', file: 'SKILL.md', line: 6 });
    expect(secret?.excerpt).not.toContain('sk-ant');
  });

  it('a link in prose is a low finding, a link in a script a medium one', () => {
    const review = reviewSkill({
      files: files({ 'SKILL.md': '---\ndescription: x\n---\nSee https://docs.example/guide.\n', 'a.py': "URL = 'https://api.example/v1'\n" }),
    });
    expect(review.findings.find((f) => f.file === 'SKILL.md' && f.rule === 'network')?.severity).toBe('low');
    expect(review.findings.find((f) => f.file === 'a.py' && f.rule === 'network')?.severity).toBe('medium');
  });

  it('flags a minified line in a script and caps the number of findings', () => {
    const minified = reviewSkill({ files: files({ 'SKILL.md': '---\ndescription: x\n---\n', 'a.js': `${'var a=1;'.repeat(200)}\n` }) });
    expect(minified.findings.find((f) => f.rule === 'obfuscation')).toMatchObject({ file: 'a.js', severity: 'medium' });
    const many = reviewSkill({ files: files({ 'SKILL.md': '---\ndescription: x\n---\n', 'a.sh': 'curl https://x.example\n'.repeat(300) }) });
    expect(many.findings).toHaveLength(MAX_FINDINGS);
    expect(many.findings.at(-1)).toMatchObject({ rule: 'truncated' });
  });

  it('lists the most severe findings first', () => {
    const review = reviewSkill({ files: files(EXFILTRATOR) });
    const order = { high: 0, medium: 1, low: 2, info: 3 };
    const severities = review.findings.map((f) => order[f.severity]);
    expect([...severities].sort((a, b) => a - b)).toEqual(severities);
  });
});

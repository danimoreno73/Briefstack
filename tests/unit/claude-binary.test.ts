import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClaudeCode,
  compatibility,
  findClaudeExecutable,
  parseVersion,
  sdkClaudeCodeVersion,
} from '../../src/creation/claudeBinary.js';

describe('installed Claude Code', () => {
  it('parses the version printed by claude --version', () => {
    expect(parseVersion('2.1.300 (Claude Code)\n')).toEqual([2, 1, 300]);
    expect(parseVersion('no version')).toBeUndefined();
  });

  it('accepts the same minor, not older; warns otherwise', () => {
    expect(compatibility([2, 1, 300], [2, 1, 286])).toBe('compatible');
    expect(compatibility([2, 1, 286], [2, 1, 286])).toBe('compatible');
    expect(compatibility([2, 1, 280], [2, 1, 286])).toBe('older');
    expect(compatibility([2, 0, 999], [2, 1, 286])).toBe('older');
    expect(compatibility([1, 9, 0], [2, 1, 286])).toBe('older');
    expect(compatibility([2, 2, 0], [2, 1, 286])).toBe('untested');
    expect(compatibility([3, 0, 0], [2, 1, 286])).toBe('untested');
  });

  it('reads the version the pinned SDK was built with', () => {
    expect(sdkClaudeCodeVersion()).toEqual([2, 1, 286]);
  });

  it('finds claude.exe on a Windows PATH, never a .cmd shim', () => {
    const files = new Set([path.win32.join('C:\\npm', 'claude.cmd'), path.win32.join('D:\\tools', 'claude.exe')]);
    const found = findClaudeExecutable({
      env: { Path: 'C:\\npm;D:\\tools' },
      platform: 'win32',
      homedir: 'C:\\Users\\someone',
      isFile: (file) => files.has(file),
    });
    expect(found).toBe(path.win32.join('D:\\tools', 'claude.exe'));
  });

  it('falls back to ~/.local/bin on POSIX', () => {
    const expected = path.posix.join('/home/someone', '.local', 'bin', 'claude');
    const found = findClaudeExecutable({
      env: { PATH: '/usr/bin:relative/dir' },
      platform: 'linux',
      homedir: '/home/someone',
      isFile: (file) => file === expected,
    });
    expect(found).toBe(expected);
  });

  it('ignores relative PATH entries', () => {
    expect(
      findClaudeExecutable({ env: { PATH: 'bin' }, platform: 'linux', homedir: '/h', isFile: () => true }),
    ).toBe(path.posix.join('/h', '.local', 'bin', 'claude'));
  });

  it('reports each outcome of the check', async () => {
    const search = { env: { PATH: '/opt' }, platform: 'linux' as const, homedir: '/h', isFile: (f: string) => f === '/opt/claude' };
    expect(await checkClaudeCode(search, async () => '2.1.300 (Claude Code)', [2, 1, 286])).toMatchObject({
      status: 'compatible',
      executable: '/opt/claude',
      installed: [2, 1, 300],
    });
    expect(await checkClaudeCode(search, async () => '2.1.200', [2, 1, 286])).toMatchObject({ status: 'older' });
    expect(await checkClaudeCode(search, async () => 'garbage', [2, 1, 286])).toEqual({
      status: 'unknownVersion',
      executable: '/opt/claude',
    });
    expect(
      await checkClaudeCode(search, async () => {
        throw new Error('spawn failed');
      }, [2, 1, 286]),
    ).toMatchObject({ status: 'unknownVersion' });
    expect(await checkClaudeCode({ ...search, isFile: () => false }, async () => '', [2, 1, 286])).toEqual({
      status: 'notFound',
    });
  });
});

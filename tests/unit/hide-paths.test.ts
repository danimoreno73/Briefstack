import { describe, expect, it } from 'vitest';
import { OUTSIDE_TEXT, hideAbsolutePaths } from '../../src/panel/project.js';

const O = OUTSIDE_TEXT;

describe('hideAbsolutePaths', () => {
  it('hides POSIX absolute paths under any top folder', () => {
    for (const p of [
      '/tmp/briefstack-folder-claims-Ab12/projects/garden',
      '/var/folders/x/y',
      '/Users/someone/projects/app',
      '/home/someone/app',
      '/mnt/c/Users/someone',
      '/opt/tools/bin',
      '/srv/data/x.md',
      '/workspaces/repo/a',
      '/c/Users/someone',
    ]) {
      expect(hideAbsolutePaths(`folder ${p} is taken`), p).toBe(`folder ${O} is taken`);
    }
    for (const p of ['/tmp', '/home', '/Users', '/var', '/mnt']) expect(hideAbsolutePaths(`in ${p} now`), p).toBe(`in ${O} now`);
  });

  it('hides Windows paths with either slash, JSON-escaped ones and UNC paths', () => {
    for (const p of [
      'C:\\Users\\someone\\projects\\app',
      'C:/Users/someone/projects/app',
      'D:\\\\data\\\\bs',
      'd:/x',
      '\\\\server\\share\\folder',
      '//server/share/folder',
    ]) {
      expect(hideAbsolutePaths(`see "${p}" here`), p).toBe(`see "${O}" here`);
    }
  });

  it('hides file: URLs, keeps web URLs, slash commands, relative paths and punctuation', () => {
    expect(hideAbsolutePaths('open file:///home/someone/x.md')).toBe(`open ${O}`);
    expect(hideAbsolutePaths('open file:///C:/Users/someone/x.md')).toBe(`open ${O}`);
    expect(hideAbsolutePaths('see https://code.claude.com/docs/en/hooks')).toBe('see https://code.claude.com/docs/en/hooks');
    expect(hideAbsolutePaths('Use /add-dir or /model.')).toBe('Use /add-dir or /model.');
    expect(hideAbsolutePaths('projects/garden and ./x/y and ~/notes/a.md, and/or 1/2')).toBe('projects/garden and ./x/y and ~/notes/a.md, and/or 1/2');
    expect(hideAbsolutePaths('Writes to /tmp/x/y.')).toBe(`Writes to ${O}.`);
    expect(hideAbsolutePaths('(at /home/me/a)')).toBe(`(at ${O})`);
  });

  it('hides several paths in one text', () => {
    expect(hideAbsolutePaths('from C:/a/b to /tmp/c/d and \\\\s\\h')).toBe(`from ${O} to ${O} and ${O}`);
  });
});

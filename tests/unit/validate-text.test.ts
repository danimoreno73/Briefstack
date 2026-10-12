import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAbsolutePaths, findSecrets, looksRandom } from '../../src/validate/index.js';

// Built by concatenation so secret scanners do not flag this test file.
const fake = {
  anthropic: 'sk-' + 'ant-api03-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z',
  openai: 'sk-' + 'proj-' + 'Zy9xWv8uTs7rQp6oNm5lKj4i',
  aws: 'AKIA' + 'Q3J7Z2KX9W4M8RTB',
  github: 'ghp' + '_' + 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2',
  githubPat: 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghij',
  slack: 'xox' + 'b-' + '123456789012-abcdefABCDEF',
  google: 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  stripe: 'sk' + '_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
  random: 'q8Zr2Lm5Tx9Wb4Nc7Vd1Hs6Kp3',
};

describe('findSecrets', () => {
  it('detects high-signal token formats', () => {
    expect(findSecrets('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['privateKey']);
    expect(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['privateKey']);
    expect(findSecrets(`key: ${fake.anthropic}`)).toContain('anthropic');
    expect(findSecrets(`export KEY=${fake.openai}`)).toContain('openai');
    expect(findSecrets(`id ${fake.aws} here`)).toEqual(['aws']);
    expect(findSecrets(fake.github)).toEqual(['github']);
    expect(findSecrets(fake.githubPat)).toEqual(['github']);
    expect(findSecrets(fake.slack)).toEqual(['slack']);
    expect(findSecrets(fake.google)).toEqual(['google']);
    expect(findSecrets(fake.stripe)).toEqual(['stripe']);
  });

  it('detects credential assignments with random-looking values', () => {
    expect(findSecrets(`api_key = "${fake.random}"`)).toEqual(['assignment']);
    expect(findSecrets(`"clientSecret": "${fake.random}",`)).toEqual(['assignment']);
    expect(findSecrets(`password: '${fake.random}'`)).toEqual(['assignment']);
    expect(findSecrets(`MY_SERVICE_TOKEN=${fake.random}`)).toEqual(['assignment']);
  });

  it('ignores documentation, placeholders and ordinary prose', () => {
    expect(findSecrets('Keep your API key in .env, never in the repo.')).toEqual([]);
    expect(findSecrets('api_key = "your-api-key-goes-here-1234"')).toEqual([]);
    expect(findSecrets('API_KEY=<your key>')).toEqual([]);
    expect(findSecrets('API_KEY=${API_KEY}')).toEqual([]);
    expect(findSecrets('token: "xxxxxxxxxxxxxxxxxxxxxxxx1"')).toEqual([]);
    expect(findSecrets('password = "correct horse battery staple"')).toEqual([]);
    expect(findSecrets('password = "short1"')).toEqual([]);
    expect(findSecrets('AKIAIOSFODNN7EXAMPLE is the AWS docs example')).toEqual([]);
    expect(findSecrets('Read(**/*.key) and Read(**/*.pem)')).toEqual([]);
    expect(findSecrets('-----BEGIN PUBLIC KEY-----')).toEqual([]);
    expect(findSecrets('Use the sk-ant- prefix check in code.')).toEqual([]);
    expect(findSecrets('"description": "Looks up tokens and secrets in the docs"')).toEqual([]);
  });

  it('judges values by length, mix and variety', () => {
    expect(looksRandom(fake.random)).toBe(true);
    expect(looksRandom('abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(looksRandom('a1a1a1a1a1a1a1a1a1a1a1')).toBe(false);
    expect(looksRandom('replace-with-real-value-123')).toBe(false);
  });
});

const win = { homedir: 'C:\\Users\\someone', pathApi: path.win32, caseInsensitive: true };
const posix = { homedir: '/home/someone', pathApi: path.posix, caseInsensitive: false };
const mac = { homedir: '/Users/someone', pathApi: path.posix, caseInsensitive: true };

const kinds = (line: string, env: typeof win) => findAbsolutePaths(line, env).map((match) => match.kind);

describe('findAbsolutePaths', () => {
  it('finds the home folder in native, slash and JSON-escaped forms, ignoring case on Windows', () => {
    expect(findAbsolutePaths('see C:\\Users\\someone\\notes.md', win)).toEqual([
      { kind: 'homeDir', match: 'C:\\Users\\someone\\notes.md', index: 4 },
    ]);
    expect(kinds('c:/users/SOMEONE/x', win)).toEqual(['homeDir']);
    expect(kinds('"dir": "C:\\\\Users\\\\someone\\\\x"', win)).toEqual(['homeDir']);
    expect(kinds('/home/someone/project', posix)).toEqual(['homeDir']);
    expect(kinds('/Users/someone/project', mac)).toEqual(['homeDir']);
  });

  it('is case-sensitive for the home folder on Linux', () => {
    // Still an absolute user folder, but not this machine's home.
    expect(kinds('/home/SOMEONE/x', posix)).toEqual(['homeFolder']);
  });

  it('does not take a longer user name for the home folder', () => {
    expect(kinds('/home/someone2/x', posix)).toEqual(['homeFolder']);
    expect(kinds('C:\\Users\\someone2', win)).toEqual(['windowsDrive']);
  });

  it('finds drive letters and user folders from other machines', () => {
    expect(kinds('D:\\work\\x', posix)).toEqual(['windowsDrive']);
    expect(kinds('open e:/data', posix)).toEqual(['windowsDrive']);
    expect(kinds('cd /Users/alice/code', win)).toEqual(['usersDir']);
    expect(kinds('cd /home/bob/code', win)).toEqual(['homeFolder']);
    expect(kinds('cp /home/bob/a /Users/carol/b', win)).toEqual(['homeFolder', 'usersDir']);
    expect(kinds('Read(//home/bob/**)', win)).toEqual(['homeFolder']);
  });

  it('allows ~ paths, deny patterns, URLs and relative paths', () => {
    for (const env of [win, posix]) {
      expect(kinds('Read(~/.ssh/**)', env)).toEqual([]);
      expect(kinds('~/briefstack-projects/garden', env)).toEqual([]);
      expect(kinds('Read(//**/.env)', env)).toEqual([]);
      expect(kinds('https://example.com/home/x and http://example.com/Users/y', env)).toEqual([]);
      expect(kinds('https://example.com/C:/x', env)).toEqual([]);
      expect(kinds('[guide](../home/notes.md) docs/home/x ./Users/y', env)).toEqual([]);
      expect(kinds('Ratio 3:/4, note:/x, see https://x.org', env)).toEqual([]);
      expect(kinds('macOS keeps homes under /Users/ and Linux under /home/', env)).toEqual([]);
    }
  });

  it('flags file:// URLs that carry a machine path', () => {
    expect(kinds('file:///C:/data/x', posix)).toEqual(['windowsDrive']);
  });

  it('skips a home folder that is a filesystem root', () => {
    expect(kinds('/etc/hosts', { ...posix, homedir: '/' })).toEqual([]);
  });
});

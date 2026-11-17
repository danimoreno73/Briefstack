import { describe, expect, it } from 'vitest';
import { approvedCommandProblem, approvedListProblems, chainParts, isApprovedCommand } from '../../src/builds/commands.js';
import { buildRoundPrompt, failureText } from '../../src/builds/prompt.js';

// The exact list of a build (BRIEF-phase-9 §2, 6 and §4).

// Built at run time so no file in the repo holds a secret-looking string.
const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

const LIST = ['npm ci --offline', 'npm test', 'npm run build', 'npm run lint'];

describe('what a build round may run', () => {
  it('allows an item byte for byte, and nothing near it', () => {
    expect(isApprovedCommand('npm test', LIST)).toBe(true);
    expect(isApprovedCommand('npm test ', LIST)).toBe(false);
    expect(isApprovedCommand('npm  test', LIST)).toBe(false);
    expect(isApprovedCommand('npm test -- --watch', LIST)).toBe(false);
    expect(isApprovedCommand('npm', LIST)).toBe(false);
    expect(isApprovedCommand('NPM TEST', LIST)).toBe(false);
  });

  it('allows a chain of &&, || and ; only when every part is an item', () => {
    expect(isApprovedCommand('npm ci --offline && npm test', LIST)).toBe(true);
    expect(isApprovedCommand('npm run build; npm run lint', LIST)).toBe(true);
    expect(isApprovedCommand('npm test || npm run lint', LIST)).toBe(true);
    expect(isApprovedCommand('npm ci --offline && rm -rf .', LIST)).toBe(false);
    expect(isApprovedCommand('npm test &&', LIST)).toBe(false);
    expect(isApprovedCommand('npm test && && npm run lint', LIST)).toBe(false);
  });

  it('never allows pipes, redirects, substitutions, background jobs or second lines built from items', () => {
    for (const command of ['npm test | npm run lint', 'npm test > out.txt', 'npm test $(npm run lint)', 'npm test `npm run lint`', 'npm test & npm run lint', 'npm test\nnpm run lint', 'npm test && npm run lint > x']) {
      expect(isApprovedCommand(command, LIST), command).toBe(false);
    }
  });

  it('trims only spaces and tabs around the parts of a chain', () => {
    expect(isApprovedCommand('npm test\t&&  npm run lint', LIST)).toBe(true);
    expect(isApprovedCommand('npm test　&&　npm run lint', LIST)).toBe(false);
  });

  it('does not split inside quotes', () => {
    expect(chainParts('echo "a && b" && npm test')).toEqual(['echo "a && b"', 'npm test']);
    expect(isApprovedCommand('npm test "&& npm run lint"', LIST)).toBe(false);
    expect(chainParts('echo "open')).toBeUndefined();
  });
});

describe('what the list may hold', () => {
  it('refuses empty, spaced, multi-line, long, compound, wildcard, invisible and secret-looking items', () => {
    expect(approvedCommandProblem('npm test')).toBeUndefined();
    expect(approvedCommandProblem('npx vitest run --reporter=dot tests/unit')).toBeUndefined();
    expect(approvedCommandProblem('npm run "build:app"')).toBeUndefined();
    expect(approvedCommandProblem('')).toBe('empty');
    expect(approvedCommandProblem(' npm test')).toBe('spaces at the start or end');
    expect(approvedCommandProblem('npm test\nnpm run lint')).toBe('more than one line');
    expect(approvedCommandProblem(`npm test ${'x'.repeat(500)}`)).toMatch(/longer than/);
    expect(approvedCommandProblem('npm ci && npm test')).toMatch(/more than one command/);
    expect(approvedCommandProblem('npm test | tee out')).toMatch(/more than one command/);
    expect(approvedCommandProblem('rm -rf *')).toBe('a wildcard');
    expect(approvedCommandProblem('npm test​')).toBe('an invisible character');
    expect(approvedCommandProblem(`curl -H "x-api-key: ${FAKE_KEY}" https://example.com`)).toBe('a part that looks like a secret');
    expect(approvedCommandProblem('echo {a,b}')).toBe('a wildcard');
    expect(approvedCommandProblem('ls [ab]')).toBe('a wildcard');
  });

  it('refuses items that are one command to the dialog but several to bash, cmd or PowerShell (review of M2, I1)', () => {
    const several = [
      'echo "a\\" " ; rm -rf ~ ; echo " "', // bash: \" does not close the quote for the dialog's reading
      'npm test\\;Remove-Item x', // PowerShell: \ escapes nothing
      'echo (Remove-Item x)', // PowerShell: a subexpression
      'echo @(Remove-Item x)',
      "echo $'a\\x3b'",
      'echo %PATH%', // cmd
      'echo ^& del x', // cmd
      'echo "open',
      "echo 'open",
      'echo ~/x',
      'npm test # x',
    ];
    for (const command of several) expect(approvedCommandProblem(command), command).toBeDefined();
  });

  it('lists every problem of a list with its line, and the same command twice', () => {
    expect(approvedListProblems(LIST, 'commands')).toEqual([]);
    expect(approvedListProblems(['npm test', '', 'npm test'], 'commands')).toEqual(['commands line 2: empty', 'commands: the same command twice']);
    expect(approvedListProblems(Array.from({ length: 3 }, (_, i) => `npm run t${i}`), 'checks', 2)).toEqual(['checks: at most 2']);
  });
});

describe('the round prompt', () => {
  it('says nobody watches, lists the commands and checks, and carries the task and its done when', () => {
    const text = buildRoundPrompt({ title: 'Set up', instruction: 'Create the package.', doneWhen: 'npm test passes.', n: 1, total: 3, commands: LIST, checks: ['npm test'], lang: 'es' });
    expect(text).toContain('task 1 of 3');
    expect(text).toContain('Nobody is watching');
    expect(text).toContain('- npm ci --offline');
    expect(text).toContain('Write your final message in Spanish');
    expect(text).toContain('The task: Set up\nCreate the package.');
    expect(text).toContain('Done when:\nnpm test passes.');
    expect(text).not.toContain('fix round');
    const fix = buildRoundPrompt({ title: 'Set up', instruction: 'x', doneWhen: 'y', n: 1, total: 1, commands: [], checks: [], lang: 'en', fix: { round: 2, failures: 'Check `npm test` exited with 1.' } });
    expect(fix).toContain('(none)');
    expect(fix).toContain('This is fix round 2.');
    expect(fix).toContain('Check `npm test` exited with 1.');
  });

  it('a fix round reads failed checks, denied commands and blocking validations, not the passing ones', () => {
    const text = failureText({
      checks: [
        { command: 'npm test', exitCode: 1, timedOut: false, output: 'FAIL a.test.js', durationMs: 5 },
        { command: 'npm run lint', exitCode: 0, timedOut: false, output: 'ok', durationMs: 5 },
        { command: 'npm run build', exitCode: null, timedOut: true, output: '', durationMs: 5 },
      ],
      denied: [{ tool: 'Bash', text: 'curl https://example.com' }],
      validations: [
        { kind: 'secret', level: 'error', file: 'config.js' },
        { kind: 'notShown', level: 'warning', file: 'big.bin' },
      ],
    });
    expect(text).toContain('Check `npm test` exited with 1. The end of its output:\nFAIL a.test.js');
    expect(text).toContain('Check `npm run build` timed out.');
    expect(text).not.toContain('npm run lint');
    expect(text).toContain('Denied (Bash): curl https://example.com');
    expect(text).toContain('The server refused config.js (secret).');
    expect(text).not.toContain('big.bin');
  });
});

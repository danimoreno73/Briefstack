import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { VERSION } from '../../src/index.js';

describe('cli', () => {
  it('reports the package version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);

    const lines: string[] = [];
    expect(main([], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([`briefstack ${VERSION}`]);
  });
});

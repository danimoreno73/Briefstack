import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexCommand } from '../src/codex/command.js';

/** The fake Codex CLI (tests/fixtures/codex/fake-codex.mjs): no model, no network, no login. */
export const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex', 'fake-codex.mjs');

/** How to start the fake Codex: this Node and the script, each call logged to `log`, with an optional scenario. */
export function fakeCodex(log?: string, scenario?: string): CodexCommand {
  return {
    file: process.execPath,
    prefix: [FAKE_CODEX, ...(log === undefined ? [] : ['--fake-log', log]), ...(scenario === undefined ? [] : ['--fake-scenario', scenario])],
  };
}

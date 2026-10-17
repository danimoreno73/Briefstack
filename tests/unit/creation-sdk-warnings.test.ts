import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildQueryOptions } from '../../src/creation/sdkRunner.js';
import {
  SHADOWED_WARNING_CODE,
  SHADOWED_WEB_TOOLS,
  filterKnownSdkWarnings,
  isKnownShadowedWarning,
} from '../../src/creation/sdkWarnings.js';
import { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL } from '../../src/creation/toolNames.js';

/** The SDK's own wording (0.3.286), with the names it lists. */
const message = (names: string[]) =>
  `canUseTool will not be invoked for: ${names.join(', ')}. Bare allowedTools entries auto-approve the whole tool before ` +
  'the callback is consulted. To gate every tool call, use a PreToolUse hook; or remove the bare names from allowedTools ' +
  'so they fall through to canUseTool. Allow rules from settings files can also shadow the callback but are not visible here.';

const ours = message([APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL]);

/**
 * Why hiding it is safe: approve_spec and grant_directory are our own tools,
 * and their handlers wait for the user's answer in the browser. A canUseTool
 * prompt for them would ask the same thing twice. Every other tool still goes
 * through the guard and canUseTool, so any warning about another tool prints.
 */
describe('the known SDK warning about shadowed canUseTool', () => {
  it('is recognised only for exactly the two briefstack-web tools', () => {
    expect(isKnownShadowedWarning([ours, { code: SHADOWED_WARNING_CODE }])).toBe(true);
    expect(isKnownShadowedWarning([message([GRANT_DIRECTORY_TOOL, APPROVE_SPEC_TOOL]), { code: SHADOWED_WARNING_CODE }])).toBe(true);
    // The older positional form: (warning, type, code).
    expect(isKnownShadowedWarning([ours, 'Warning', SHADOWED_WARNING_CODE])).toBe(true);
    expect(isKnownShadowedWarning([new Error(ours), { code: SHADOWED_WARNING_CODE }])).toBe(true);
  });

  it('is not recognised when another tool is listed, one is missing, the code differs or the shape changed', () => {
    for (const args of [
      [message([APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL, 'Bash']), { code: SHADOWED_WARNING_CODE }],
      [message(['Write']), { code: SHADOWED_WARNING_CODE }],
      [message([APPROVE_SPEC_TOOL]), { code: SHADOWED_WARNING_CODE }],
      [ours, { code: 'SOMETHING_ELSE' }],
      [ours],
      [ours, 'Warning'],
      [`Tools shadowed: ${APPROVE_SPEC_TOOL}, ${GRANT_DIRECTORY_TOOL}`, { code: SHADOWED_WARNING_CODE }],
      [42, { code: SHADOWED_WARNING_CODE }],
    ]) {
      expect(isKnownShadowedWarning(args), JSON.stringify(args)).toBe(false);
    }
  });

  it('is dropped by the filter, and every other warning still reaches the original emitter', () => {
    const emitted = vi.fn();
    const target = { emitWarning: emitted as (...args: never[]) => void };
    filterKnownSdkWarnings(target);
    filterKnownSdkWarnings(target); // installed once
    const emit = target.emitWarning as unknown as (...args: unknown[]) => void;

    emit(ours, { code: SHADOWED_WARNING_CODE });
    expect(emitted).not.toHaveBeenCalled();

    const other = message(['Bash']);
    emit(other, { code: SHADOWED_WARNING_CODE });
    emit('Something else', { code: 'DEP0001' });
    emit('Plain warning');
    expect(emitted.mock.calls).toEqual([[other, { code: SHADOWED_WARNING_CODE }], ['Something else', { code: 'DEP0001' }], ['Plain warning']]);
  });

  it('keeps allowedTools to exactly those two names', () => {
    expect(SHADOWED_WEB_TOOLS).toEqual([APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL]);
    const options = buildQueryOptions({
      repoDir: 'repo',
      executable: 'claude',
      profile: { name: 'balanced', sessionModel: 'sonnet' },
      env: {},
      additionalDirectories: [],
      hooks: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
      mcpServers: {},
      abortController: new AbortController(),
      spawn: () => {
        throw new Error('not spawned');
      },
    });
    expect(options.allowedTools).toEqual([APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL]);
  });

  it('matches what the installed SDK emits (an upgrade that changes it shows the warning again)', async () => {
    const require = createRequire(import.meta.url);
    const sdk = path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'sdk.mjs');
    const text = await readFile(sdk, 'utf8');
    expect(text).toContain(`code:"${SHADOWED_WARNING_CODE}"`);
    expect(text).toContain('`canUseTool will not be invoked for: ${');
    expect(text).toContain('}. Bare allowedTools entries auto-approve the whole tool');
  });
});

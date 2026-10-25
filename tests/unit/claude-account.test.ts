import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeStatusReader, authModeOf, claudeNeedsAction, hasPlanLimits, keySourceLabel, readAuthMode, type AuthMode } from '../../src/creation/claudeAccount.js';
import type { ClaudeCheck } from '../../src/creation/claudeBinary.js';

describe('authModeOf', () => {
  // The answers Claude Code 2.1.310 gave in probes (decisions.md, "Release"), without e-mail or organization.
  it('reads a Claude plan sign-in', () => {
    expect(authModeOf({ apiProvider: 'firstParty', subscriptionType: 'Claude Pro' })).toEqual({ kind: 'signIn', plan: 'Claude Pro' });
  });

  it('reads an API key from the environment, even with a claude.ai sign-in also stored', () => {
    expect(authModeOf({ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'claude.ai' })).toEqual({ kind: 'apiKey', source: 'environment' });
  });

  it('reads a bearer token for a gateway as an API key', () => {
    expect(authModeOf({ apiProvider: 'firstParty', tokenSource: 'ANTHROPIC_AUTH_TOKEN' })).toEqual({ kind: 'apiKey', source: 'bearer' });
  });

  it('reads no credential', () => {
    expect(authModeOf({ apiProvider: 'firstParty', tokenSource: 'none' })).toEqual({ kind: 'none' });
    expect(authModeOf({})).toEqual({ kind: 'none' });
  });

  it('reads the other key sources, a long-lived sign-in token and a cloud provider', () => {
    expect(authModeOf({ apiKeySource: 'apiKeyHelper' })).toEqual({ kind: 'apiKey', source: 'helper' });
    expect(authModeOf({ apiKeySource: '/login managed key' })).toEqual({ kind: 'apiKey', source: 'login' });
    expect(authModeOf({ apiKeySource: 'org' })).toEqual({ kind: 'apiKey', source: 'other' });
    expect(authModeOf({ apiKeySource: 'none', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' })).toEqual({ kind: 'signIn' });
    expect(authModeOf({ apiProvider: 'bedrock', apiKeySource: 'ANTHROPIC_API_KEY' })).toEqual({ kind: 'cloud', provider: 'bedrock' });
    expect(authModeOf({ apiProvider: 'gateway' })).toEqual({ kind: 'cloud', provider: 'gateway' });
  });

  it('has plan limits only with a Claude plan, and names key sources the same in every language', () => {
    expect(hasPlanLimits({ kind: 'signIn' })).toBe(true);
    for (const mode of [{ kind: 'apiKey', source: 'environment' }, { kind: 'cloud', provider: 'vertex' }, { kind: 'none' }, { kind: 'unknown' }] as AuthMode[]) {
      expect(hasPlanLimits(mode)).toBe(false);
    }
    expect(keySourceLabel('environment')).toBe('ANTHROPIC_API_KEY');
    expect(keySourceLabel('bearer')).toBe('ANTHROPIC_AUTH_TOKEN');
  });
});

/** A fake `query` whose `accountInfo` answers as given; records how it was called and closed. */
function fakeQuery(answer: () => Promise<unknown>) {
  const seen: { options?: Record<string, unknown>; closed: number } = { closed: 0 };
  const query = ((params: { options: Record<string, unknown> }) => {
    seen.options = params.options;
    return { accountInfo: answer, close: () => (seen.closed += 1) };
  }) as unknown as typeof sdkQuery;
  return { query, seen };
}

describe('readAuthMode', () => {
  it('asks a session that sends no message, with no settings files, and closes it; only the mode comes back', async () => {
    const { query, seen } = fakeQuery(async () => ({ apiProvider: 'firstParty', subscriptionType: 'Claude Max', email: 'someone@example.com', organization: 'Org' }));
    const mode = await readAuthMode({ cwd: '/repo', executable: '/bin/claude', env: { PATH: '/bin' }, query });
    expect(mode).toEqual({ kind: 'signIn', plan: 'Claude Max' });
    expect(JSON.stringify(mode)).not.toContain('example.com');
    expect(seen.options).toMatchObject({ cwd: '/repo', pathToClaudeCodeExecutable: '/bin/claude', settingSources: [] });
    expect(seen.closed).toBe(1);
  });

  it('is unknown when Claude Code fails or does not answer in time, and never throws', async () => {
    const failing = fakeQuery(async () => {
      throw new Error('spawn failed');
    });
    expect(await readAuthMode({ cwd: '/r', executable: 'c', env: {}, query: failing.query })).toEqual({ kind: 'unknown' });
    expect(failing.seen.closed).toBe(1);
    const silent = fakeQuery(() => new Promise(() => undefined));
    expect(await readAuthMode({ cwd: '/r', executable: 'c', env: {}, query: silent.query, timeoutMs: 20 })).toEqual({ kind: 'unknown' });
    expect(silent.seen.closed).toBe(1);
  });
});

describe('ClaudeStatusReader', () => {
  const compatible: ClaudeCheck = { status: 'compatible', executable: '/bin/claude', installed: [2, 1, 310], expected: [2, 1, 286] };

  it('reads once, keeps it, and reads again on refresh; no executable path in what it gives', async () => {
    let checks = 0;
    let asked: string[] = [];
    const reader = new ClaudeStatusReader({
      check: async () => (checks += 1, compatible),
      mode: async (executable) => (asked.push(executable), { kind: 'signIn' }),
    });
    const first = await reader.get();
    expect(first).toEqual({ install: { status: 'compatible', installed: '2.1.310', expected: '2.1.286' }, mode: { kind: 'signIn' } });
    expect(JSON.stringify(first)).not.toContain('/bin/claude');
    await reader.get();
    expect(checks).toBe(1);
    await reader.get(true);
    expect(checks).toBe(2);
    expect(asked).toEqual(['/bin/claude', '/bin/claude']);
    asked = [];
  });

  it('does not ask a Claude Code that is not there, and says when something keeps a creation from working', async () => {
    let asked = 0;
    const missing = new ClaudeStatusReader({ check: async () => ({ status: 'notFound' }), mode: async () => (asked += 1, { kind: 'signIn' }) });
    const status = await missing.get();
    expect(status).toEqual({ install: { status: 'notFound' }, mode: { kind: 'unknown' } });
    expect(asked).toBe(0);
    expect(claudeNeedsAction(status)).toBe(true);
    const failing = new ClaudeStatusReader({ check: async () => compatible, mode: async () => Promise.reject(new Error('x')) });
    expect((await failing.get()).mode).toEqual({ kind: 'unknown' });
    expect(claudeNeedsAction({ install: { status: 'compatible', installed: '2.1.310', expected: '2.1.286' }, mode: { kind: 'none' } })).toBe(true);
    expect(claudeNeedsAction({ install: { status: 'older', installed: '2.1.200', expected: '2.1.286' }, mode: { kind: 'signIn' } })).toBe(true);
    expect(claudeNeedsAction({ install: { status: 'compatible', installed: '2.1.310', expected: '2.1.286' }, mode: { kind: 'apiKey', source: 'environment' } })).toBe(false);
  });
});

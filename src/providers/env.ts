import { readFile, stat } from 'node:fs/promises';
import { BriefstackError } from '../errors.js';
import type { ReserveProvider } from './config.js';

/**
 * A reserve provider's round (phase 12; PLAN-phase-12 §1, 10; decisions.md,
 * "Phase 12: H0", 3): the round's clean environment with every Anthropic
 * credential taken out, and the provider's base URL, key and models put in.
 * The key is read from its file when the round starts and goes only into
 * that round's environment: never stored, logged, shown or returned.
 */

/** The longest key file read. A key is short; anything longer is not one. */
export const MAX_KEY_BYTES = 4096;

/**
 * What decides where Claude Code sends a request and with which credential:
 * every `ANTHROPIC_*` (keys, tokens, base URL, custom headers, model
 * aliases), the cloud provider switches and their auth skips, and the
 * long-lived sign-in tokens (code.claude.com/docs/en/authentication and
 * /env-vars). None of the user's own may reach a provider's round.
 */
export function isAnthropicCredential(name: string): boolean {
  return name.startsWith('ANTHROPIC_') || /^CLAUDE_CODE_(?:USE_|SKIP_[A-Z_]*AUTH$|OAUTH_)/.test(name);
}

/** The round's environment on `provider`, from the clean environment every round gets. */
export function providerEnvironment(clean: Readonly<Record<string, string | undefined>>, provider: ReserveProvider, key: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(clean)) {
    if (value === undefined || isAnthropicCredential(name)) continue;
    env[name] = value;
  }
  const small = provider.smallModel ?? provider.model;
  return {
    ...env,
    ANTHROPIC_BASE_URL: provider.baseUrl,
    // "Sent as the Authorization: Bearer header" (authentication precedence): what both providers document.
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_OPUS_MODEL: provider.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: provider.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: provider.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: small,
    // No telemetry, error reports or update checks towards Anthropic from a round that is not on Anthropic.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** Whether a provider's key file is there and not empty, by its size only: its content is not read. */
export async function keyFileState(keyFile: string): Promise<'present' | 'missing' | 'empty'> {
  try {
    const info = await stat(keyFile);
    if (!info.isFile()) return 'missing';
    return info.size === 0 ? 'empty' : 'present';
  } catch {
    return 'missing';
  }
}

/**
 * Reads a provider's key, at a round's start only: the file's text without
 * a byte-order mark and surrounding white space, on one line. Errors name
 * the provider and the file, never what it holds.
 */
export async function readProviderKey(provider: ReserveProvider): Promise<string> {
  let text: string;
  try {
    const info = await stat(provider.keyFile);
    if (!info.isFile() || info.size > MAX_KEY_BYTES) throw new Error('not a key file');
    text = await readFile(provider.keyFile, 'utf8');
  } catch {
    throw new BriefstackError('provider.keyUnreadable', { name: provider.name, file: provider.keyFile });
  }
  const key = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  if (key === '' || /[\r\n]/.test(key)) throw new BriefstackError('provider.keyUnreadable', { name: provider.name, file: provider.keyFile });
  return key;
}

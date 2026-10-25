import { query as sdkQuery, type AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { resolveHome, type PathEnv } from '../config/index.js';
import { checkClaudeCode, formatVersion, type ClaudeCheck } from './claudeBinary.js';
import { cleanEnvironment } from './sdkRunner.js';

/**
 * How the user's own Claude Code signs in, as Claude Code reports it
 * (`accountInfo()`, read from a session that sends no message). briefstack
 * never reads, stores or forwards credentials: this is Claude Code's own
 * answer, reduced to the kind of sign-in. The account's e-mail and
 * organization are never kept (docs/decisions.md, "Release").
 */
export type AuthMode =
  /** A Claude plan (`/login` with a claude.ai account, or `CLAUDE_CODE_OAUTH_TOKEN`); `plan` as Claude Code names it. */
  | { kind: 'signIn'; plan?: string }
  /** Billed per use to a key: `ANTHROPIC_API_KEY`, `apiKeyHelper`, a key from a Console `/login`, or `ANTHROPIC_AUTH_TOKEN` for a gateway. */
  | { kind: 'apiKey'; source: 'environment' | 'helper' | 'login' | 'bearer' | 'other' }
  /** A cloud provider or an enterprise gateway, billed by that provider. */
  | { kind: 'cloud'; provider: string }
  /** Claude Code has no credential. */
  | { kind: 'none' }
  /** Claude Code could not be asked. */
  | { kind: 'unknown' };

const KEY_SOURCES: Record<string, Extract<AuthMode, { kind: 'apiKey' }>['source']> = {
  ANTHROPIC_API_KEY: 'environment',
  apiKeyHelper: 'helper',
  '/login managed key': 'login',
};

/** The kind of sign-in in Claude Code's own account answer. Values verified with probes (decisions.md, "Release"). */
export function authModeOf(info: Pick<AccountInfo, 'apiProvider' | 'apiKeySource' | 'tokenSource' | 'subscriptionType'>): AuthMode {
  if (info.apiProvider !== undefined && info.apiProvider !== 'firstParty') return { kind: 'cloud', provider: info.apiProvider };
  if (info.apiKeySource !== undefined && info.apiKeySource !== 'none') return { kind: 'apiKey', source: KEY_SOURCES[info.apiKeySource] ?? 'other' };
  if (info.tokenSource === 'ANTHROPIC_AUTH_TOKEN') return { kind: 'apiKey', source: 'bearer' };
  if (info.subscriptionType !== undefined) return { kind: 'signIn', plan: info.subscriptionType };
  if (info.tokenSource !== undefined && info.tokenSource !== 'none') return { kind: 'signIn' };
  return { kind: 'none' };
}

/** Where an API key comes from, in the names the user set it with. The same in every language. */
export function keySourceLabel(source: Extract<AuthMode, { kind: 'apiKey' }>['source']): string {
  const labels = { environment: 'ANTHROPIC_API_KEY', helper: 'apiKeyHelper', login: 'Console /login', bearer: 'ANTHROPIC_AUTH_TOKEN', other: 'key' } as const;
  return labels[source];
}

/** Whether plan limits mean anything for this mode: only with a Claude plan. */
export const hasPlanLimits = (mode: AuthMode): boolean => mode.kind === 'signIn';

export interface AuthModeOptions {
  /** Working folder of the reading session. It sends no message, so nothing runs there. */
  cwd: string;
  executable: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Injected in tests. */
  query?: typeof sdkQuery;
}

/** Asks the user's Claude Code how it signs in. Never throws: a failure is `unknown`. */
export async function readAuthMode(options: AuthModeOptions): Promise<AuthMode> {
  const neverSends: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => undefined) }),
  };
  const run = options.query ?? sdkQuery;
  let q: ReturnType<typeof sdkQuery> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    q = run({
      prompt: neverSends,
      options: { cwd: options.cwd, pathToClaudeCodeExecutable: options.executable, env: options.env, settingSources: [] },
    });
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), options.timeoutMs ?? 30_000);
    });
    const info = await Promise.race([q.accountInfo(), timeout]);
    return info === undefined ? { kind: 'unknown' } : authModeOf(info);
  } catch {
    return { kind: 'unknown' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    q?.close();
  }
}

/** What the web shows about Claude Code: no path to the executable, no account details, no secret. */
export interface ClaudeStatus {
  install:
    | { status: 'notFound' }
    | { status: 'unknownVersion' }
    | { status: 'compatible' | 'older' | 'untested'; installed: string; expected: string };
  mode: AuthMode;
}

export function installOf(check: ClaudeCheck): ClaudeStatus['install'] {
  if (check.status === 'notFound' || check.status === 'unknownVersion') return { status: check.status };
  return { status: check.status, installed: formatVersion(check.installed), expected: formatVersion(check.expected) };
}

/** Whether something keeps a creation from working, so the web says what to do. */
export const claudeNeedsAction = (status: ClaudeStatus): boolean =>
  status.install.status === 'notFound' || status.install.status === 'older' || status.mode.kind === 'none';

export interface ClaudeStatusDeps {
  /** Finds `claude` and reads its version. */
  check: () => Promise<ClaudeCheck>;
  /** Asks that `claude` how it signs in. */
  mode: (executable: string) => Promise<AuthMode>;
}

/** The real readings: the user's `claude`, asked with the same clean environment as a creation. */
export function realClaudeStatusDeps(options: { pathEnv: PathEnv; repoDir: string }): ClaudeStatusDeps {
  const { pathEnv, repoDir } = options;
  return {
    check: () => checkClaudeCode({ env: pathEnv.env, platform: process.platform, homedir: pathEnv.homedir }),
    mode: (executable) => readAuthMode({ cwd: repoDir, executable, env: cleanEnvironment(pathEnv.env, resolveHome(pathEnv)).env }),
  };
}

/** Reads the status once and keeps it; `refresh` reads again (the Settings page's "Check again"). */
export class ClaudeStatusReader {
  private current: Promise<ClaudeStatus> | undefined;

  constructor(private readonly deps: ClaudeStatusDeps) {}

  get(refresh = false): Promise<ClaudeStatus> {
    if (this.current === undefined || refresh) this.current = this.read();
    return this.current;
  }

  private async read(): Promise<ClaudeStatus> {
    const check = await this.deps.check();
    const install = installOf(check);
    if (check.status === 'notFound') return { install, mode: { kind: 'unknown' } };
    return { install, mode: await this.deps.mode(check.executable).catch((): AuthMode => ({ kind: 'unknown' })) };
  }
}

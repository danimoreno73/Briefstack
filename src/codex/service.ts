import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { codexSettingsOf, configFilePath, readConfig, resolveHome, type PathEnv } from '../config/index.js';
import type { TrackedSpawn } from '../creation/processTree.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { redactSecretLines } from '../validate/secrets.js';
import { findCodex, type CodexCommand } from './command.js';
import { codexEnvironment } from './env.js';
import { CODEX_SANDBOX_MODES, type CodexSandboxMode } from './limits.js';
import { runCodexProcess, type CodexProcessResult } from './runner.js';
import type { CodexSession } from './tool.js';

/**
 * Codex in Settings (decisions.md, "Phase 8: step 25"): the switch, the
 * Windows sandbox mode and the calls per round live in the config; the
 * status is read only when the user asks ("Check"), never when the page
 * opens, and the last check is kept in `<home>/codex/status.json`. A task
 * round gets `delegate_to_codex` only when the switch is on, the last check
 * passed (for the mode chosen now, on Windows) and Codex is still found.
 * The check runs `codex --version`, `codex login status` (its exit code and
 * stderr; `auth.json` is never read) and `codex sandbox ... -- whoami`; none
 * of them uses the plan.
 */

const checkSchema = z.object({ ok: z.boolean(), text: z.string() });
const statusSchema = z.object({
  v: z.literal(1),
  at: z.string(),
  platform: z.string(),
  /** The mode the sandbox check ran with (Windows only). */
  mode: z.enum(CODEX_SANDBOX_MODES).optional(),
  found: z.boolean(),
  version: checkSchema,
  login: checkSchema,
  sandbox: checkSchema,
  ok: z.boolean(),
});
export type CodexStatus = z.infer<typeof statusSchema>;

/** Why tasks do not get the tool. */
export type CodexUnavailableReason = 'off' | 'notChecked' | 'checkFailed' | 'modeChanged';

export interface CodexView {
  enabled: boolean;
  mode: CodexSandboxMode;
  maxCalls: number;
  /** The sandbox mode is offered only on Windows (not verified elsewhere). */
  modeOffered: boolean;
  last?: CodexStatus;
  /** Whether task rounds get the tool now (Codex is looked for again when a round starts). */
  available: boolean;
  reason?: CodexUnavailableReason;
}

export interface CodexServiceDeps {
  pathEnv: PathEnv;
  platform?: NodeJS.Platform;
  /** Where Codex is; the PATH by default. Tests pass the fake Codex. */
  locate?: () => CodexCommand | undefined;
  /** Each check command's deadline. Default 60 s. */
  checkTimeoutMs?: number;
  tracked?: () => TrackedSpawn;
  now?: () => Date;
}

const MAX_CHECK_TEXT = 300;

/** What the page may show of a check's output: one short text, secrets and absolute paths hidden. */
const shown = (text: string): string => hideAbsolutePaths(redactSecretLines(text.trim())).slice(0, MAX_CHECK_TEXT);

/** Why task rounds do not get the tool, or `undefined` when they do. */
export function codexUnavailableReason(settings: { enabled: boolean; mode: CodexSandboxMode }, last: CodexStatus | undefined, platform: NodeJS.Platform): CodexUnavailableReason | undefined {
  if (!settings.enabled) return 'off';
  if (last === undefined || last.platform !== platform) return 'notChecked';
  if (!last.ok) return 'checkFailed';
  if (platform === 'win32' && last.mode !== settings.mode) return 'modeChanged';
  return undefined;
}

export class CodexService {
  private checking: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CodexServiceDeps) {}

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private folder(): string {
    return path.join(resolveHome(this.deps.pathEnv), 'codex');
  }

  private statusFile(): string {
    return path.join(this.folder(), 'status.json');
  }

  private locate(): CodexCommand | undefined {
    return (this.deps.locate ?? (() => findCodex({ env: this.deps.pathEnv.env, platform: this.platform })))();
  }

  private async settings(): Promise<{ enabled: boolean; mode: CodexSandboxMode; maxCalls: number }> {
    return codexSettingsOf(await readConfig(configFilePath(this.deps.pathEnv)));
  }

  /** The last check, or `undefined` when there is none or it does not read back. */
  async lastCheck(): Promise<CodexStatus | undefined> {
    try {
      const parsed = statusSchema.safeParse(JSON.parse(await readFile(this.statusFile(), 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** The settings, the last check and whether rounds get the tool. Runs nothing. */
  async view(): Promise<CodexView> {
    const settings = await this.settings();
    const last = await this.lastCheck();
    const reason = codexUnavailableReason(settings, last, this.platform);
    return { ...settings, modeOffered: this.platform === 'win32', ...(last === undefined ? {} : { last }), available: reason === undefined, ...(reason === undefined ? {} : { reason }) };
  }

  /** Runs the three checks (one check at a time), keeps the result, and returns the view. */
  check(): Promise<CodexView> {
    const run = this.checking.then(() => this.checkNow());
    this.checking = run.catch(() => undefined);
    return run;
  }

  private async checkNow(): Promise<CodexView> {
    const { mode } = await this.settings();
    const windows = this.platform === 'win32';
    const command = this.locate();
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    let status: CodexStatus;
    if (command === undefined) {
      const none = { ok: false, text: '' };
      status = { v: 1, at, platform: this.platform, ...(windows ? { mode } : {}), found: false, version: none, login: none, sandbox: none, ok: false };
    } else {
      const cwd = path.join(this.folder(), 'check');
      await mkdir(cwd, { recursive: true });
      const { env } = codexEnvironment(this.deps.pathEnv.env);
      const run = (args: string[]): Promise<CodexProcessResult> =>
        runCodexProcess({ command, args, cwd, env, timeoutMs: this.deps.checkTimeoutMs ?? 60_000, ...(this.deps.tracked === undefined ? {} : { tracked: this.deps.tracked }) });
      const passed = (ran: CodexProcessResult) => ran.ended === 'exited' && ran.exitCode === 0;
      const versionRun = await run(['--version']);
      const version = { ok: passed(versionRun) && versionRun.stdout.trim() !== '', text: shown(versionRun.stdout.split(/\r?\n/)[0] ?? '') };
      const loginRun = await run(['login', 'status']);
      const login = { ok: passed(loginRun), text: shown(loginRun.stderr.trim() !== '' ? loginRun.stderr : loginRun.stdout) };
      // The measured sandbox call, without the model: `-P :workspace` with the mode on Windows, and `whoami` in it.
      const sandboxRun = await run(['sandbox', ...(windows ? ['-c', `windows.sandbox="${mode}"`] : []), '-P', ':workspace', '--', 'whoami']);
      const sandbox = { ok: passed(sandboxRun), text: shown(passed(sandboxRun) ? sandboxRun.stdout : sandboxRun.stderr.trim() !== '' ? sandboxRun.stderr : sandboxRun.stdout) };
      status = { v: 1, at, platform: this.platform, ...(windows ? { mode } : {}), found: true, version, login, sandbox, ok: version.ok && login.ok && sandbox.ok };
    }
    await mkdir(this.folder(), { recursive: true });
    const temp = `${this.statusFile()}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    await rename(temp, this.statusFile());
    return this.view();
  }

  /** What a task round needs to offer `delegate_to_codex`, or `undefined` when it does not get the tool. */
  async session(): Promise<Omit<CodexSession, 'outDir'> | undefined> {
    const settings = await this.settings();
    if (codexUnavailableReason(settings, await this.lastCheck(), this.platform) !== undefined) return undefined;
    const command = this.locate();
    if (command === undefined) return undefined;
    return { command, maxCalls: settings.maxCalls, ...(this.platform === 'win32' ? { mode: settings.mode } : {}) };
  }
}

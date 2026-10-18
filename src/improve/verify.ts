import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { hideAbsolutePaths } from '../panel/project.js';
import { redactSecretLines } from '../validate/secrets.js';
import { NODE_MODULES, cleanIgnored, linkNodeModules, unlinkNodeModules } from './git.js';
import type { CheckReport, CheckStep } from './proposal.js';

/**
 * Build, lint and all tests in the worktree, run by the server (BRIEF-phase-5
 * §2.4, §3.3), only after the validators passed. `node_modules` is the repo's,
 * linked for the run and unlinked after (H0 #2), then what git ignores (the
 * build output) is removed; no network: every proxy
 * variable points at a closed port and npm is offline.
 */

export interface Verifier {
  verify(worktreeDir: string): Promise<CheckReport>;
}

const STEPS: { name: CheckStep['name']; script: string }[] = [
  { name: 'build', script: 'npm run build' },
  { name: 'lint', script: 'npm run lint' },
  { name: 'test', script: 'npm test' },
];
const STEP_TIMEOUT_MS = 15 * 60_000;
const TAIL_LINES = 25;

const CLOSED_PROXY = 'http://127.0.0.1:9';

/** The environment of a check: no network, no credentials. */
export function offlineEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(name)) continue;
    env[name] = value;
  }
  return {
    ...env,
    HTTP_PROXY: CLOSED_PROXY,
    HTTPS_PROXY: CLOSED_PROXY,
    http_proxy: CLOSED_PROXY,
    https_proxy: CLOSED_PROXY,
    NO_PROXY: '',
    no_proxy: '',
    npm_config_offline: 'true',
    CI: '1',
  };
}

/** The last lines of an output, redacted and without absolute paths. */
export function tailOf(output: string, lines = TAIL_LINES): string {
  return hideAbsolutePaths(redactSecretLines(output.trimEnd().split(/\r?\n/).slice(-lines).join('\n')));
}

function runScript(cwd: string, script: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    // A fixed command line: on Windows npm is a .cmd, which only a shell runs.
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', script], { cwd, env, windowsHide: true })
        : spawn('sh', ['-c', script], { cwd, env });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-64 * 1024);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${error.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output, ms: Date.now() - started });
    });
  });
}

export class NpmVerifier implements Verifier {
  constructor(private readonly repoDir: string) {}

  async verify(worktreeDir: string): Promise<CheckReport> {
    try {
      await stat(path.join(this.repoDir, NODE_MODULES));
    } catch {
      return { ok: false, steps: [], error: 'The repository has no node_modules. Run npm ci in it first.' };
    }
    await linkNodeModules(this.repoDir, worktreeDir);
    const steps: CheckStep[] = [];
    try {
      const env = offlineEnv(process.env);
      for (const step of STEPS) {
        const result = await runScript(worktreeDir, step.script, env);
        steps.push({ name: step.name, ok: result.ok, ms: result.ms, tail: tailOf(result.output) });
      }
    } finally {
      await unlinkNodeModules(worktreeDir).catch(() => undefined);
      // The build output would count as a file left outside git in the next round.
      await cleanIgnored(worktreeDir).catch(() => undefined);
    }
    return { ok: steps.every((step) => step.ok), steps };
  }
}

/** A verifier for tests: a fixed report, or one per call. */
export class FakeVerifier implements Verifier {
  readonly calls: string[] = [];
  constructor(private readonly reports: CheckReport[] = [{ ok: true, steps: STEPS.map((step) => ({ name: step.name, ok: true, ms: 10, tail: `${step.name} ok` })) }]) {}

  async verify(worktreeDir: string): Promise<CheckReport> {
    this.calls.push(worktreeDir);
    return this.reports[Math.min(this.calls.length - 1, this.reports.length - 1)] as CheckReport;
  }
}

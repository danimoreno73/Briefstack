import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { linkNodeModules, unlinkNodeModules } from './git.js';
import type { ProposalFile, RealCheckName } from './proposal.js';
import { tailOf } from './verify.js';

/**
 * The optional cheap real check of a proposal (BRIEF-phase-5 §2.4, §3.3):
 * offered only when the change affects model behaviour, started only by the
 * user from the proposal page. It runs the matching `scripts/real/` script
 * from the proposal's worktree, so it uses the improved files, with the
 * scripts' own temp home (Haiku or the saver profile). Its scripts are not
 * allowlisted, so they are the repo's own.
 */

export interface RealCheckInfo {
  name: RealCheckName;
  script: string;
  /** One line for the page: what it spends. */
  cost: { en: string; es: string };
}

export const REAL_CHECKS: Record<RealCheckName, RealCheckInfo> = {
  'interviewer-target': {
    name: 'interviewer-target',
    script: 'scripts/real/check-interviewer-target.ts',
    cost: {
      en: 'Four short interviewer runs on Haiku in a temp home: a few minutes and a small part of your plan.',
      es: 'Cuatro ejecuciones cortas del entrevistador con Haiku en un home temporal: unos minutos y una parte pequeña de tu plan.',
    },
  },
  'improvement-flow': {
    name: 'improvement-flow',
    script: 'scripts/real/check-improvement-flow.ts',
    cost: {
      en: 'One whole creation in a temp home (session on the saver profile, agents on the models their files hold): up to 25 minutes and a noticeable part of your plan.',
      es: 'Una creación completa en un home temporal (sesión con el perfil ahorro, agentes con los modelos de sus archivos): hasta 25 minutos y una parte apreciable de tu plan.',
    },
  },
};

/** The check a change calls for: the interviewer's for the interviewer or the target rule, a whole creation for any other flow asset. */
export function offeredCheck(files: readonly Pick<ProposalFile, 'path' | 'kind'>[]): RealCheckName | undefined {
  const allowed = files.filter((file) => file.kind !== 'other');
  if (allowed.length === 0) return undefined;
  const interviewerOnly = allowed.every((file) => file.path === '.claude/agents/interviewer.md' || file.path === 'library/rules/target.md');
  return interviewerOnly ? 'interviewer-target' : 'improvement-flow';
}

export interface RealCheckRunner {
  run(name: RealCheckName, worktreeDir: string): Promise<{ ok: boolean; output: string }>;
}

/** Keeps the PASS and FAIL lines and the last lines of the output. */
export function checkOutput(output: string): string {
  const verdicts = output.split(/\r?\n/).filter((line) => /^(PASS|FAIL)\s/.test(line));
  return tailOf([...verdicts, '', '…', tailOf(output, 15)].join('\n'), 60);
}

export class ScriptRealCheckRunner implements RealCheckRunner {
  constructor(private readonly repoDir: string) {}

  async run(name: RealCheckName, worktreeDir: string): Promise<{ ok: boolean; output: string }> {
    const script = path.join(worktreeDir, ...REAL_CHECKS[name].script.split('/'));
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    await linkNodeModules(this.repoDir, worktreeDir);
    try {
      return await new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', loader, script, '--yes'], { cwd: worktreeDir, env: process.env, windowsHide: true });
        let output = '';
        const keep = (chunk: Buffer) => (output = (output + chunk.toString('utf8')).slice(-128 * 1024));
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', (error) => resolve({ ok: false, output: checkOutput(`${output}\n${error.message}`) }));
        child.on('close', (code) => resolve({ ok: code === 0, output: checkOutput(output) }));
      });
    } finally {
      await unlinkNodeModules(worktreeDir).catch(() => undefined);
    }
  }
}

export class FakeRealCheckRunner implements RealCheckRunner {
  readonly calls: { name: RealCheckName; worktreeDir: string }[] = [];
  constructor(private readonly result: { ok: boolean; output: string } = { ok: true, output: 'PASS  fake check' }) {}

  async run(name: RealCheckName, worktreeDir: string): Promise<{ ok: boolean; output: string }> {
    this.calls.push({ name, worktreeDir });
    return this.result;
  }
}

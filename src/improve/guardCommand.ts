import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { systemPathEnv } from '../config/paths.js';
import { evaluateImproveToolUse } from './guard.js';

/**
 * The improvement guard as a Claude Code command hook (BRIEF-phase-5 §4: "the
 * independent command-hook guard from phase 4, configured for their
 * worktree"). Claude Code runs it itself, so it holds when the server is
 * gone. It reads the rules from `guard.json` in the proposal's folder
 * (outside the worktree and the evidence, where the session cannot write),
 * applies `evaluateImproveToolUse`, and only denies (exit code 2). Rules it
 * cannot read, input it cannot parse, or any error: exit 2. Registered with
 * `onFailure: "block"`, so a hook that cannot start blocks the call.
 */

export const IMPROVE_RULES_FILE = 'guard.json';
export const IMPROVE_GUARD_TIMEOUT_S = 60;

const absolute = z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path');

const rulesSchema = z
  .object({
    v: z.literal(1),
    worktree: absolute,
    evidence: z.array(absolute),
    submitTool: z.string().min(1),
  })
  .strict();

export type ImproveRulesFile = z.infer<typeof rulesSchema>;

export function writeImproveRulesSync(file: string, rules: ImproveRulesFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

const inputSchema = z.looseObject({
  hook_event_name: z.string(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
});

export interface CommandVerdict {
  code: 0 | 2;
  message?: string;
}

const deny = (message: string): CommandVerdict => ({ code: 2, message });

/** Decides one hook call from its stdin and the rules file. Never throws. */
export async function decideImproveToolUse(stdin: string, rulesFile: string): Promise<CommandVerdict> {
  try {
    let rules: ImproveRulesFile;
    try {
      const parsed = rulesSchema.safeParse(JSON.parse(readFileSync(rulesFile, 'utf8')));
      if (!parsed.success) return deny('briefstack improvement guard: the rules are not valid, so nothing is allowed.');
      rules = parsed.data;
    } catch {
      return deny('briefstack improvement guard: the rules cannot be read, so nothing is allowed.');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      return deny('briefstack improvement guard: the hook input is not JSON.');
    }
    const input = inputSchema.safeParse(raw);
    if (!input.success) return deny('briefstack improvement guard: the hook input is not in the expected shape.');
    if (input.data.hook_event_name !== 'PreToolUse') return { code: 0 };
    if (input.data.tool_name === undefined) return deny('briefstack improvement guard: the hook input names no tool.');
    const verdict = await evaluateImproveToolUse(rules, { tool_name: input.data.tool_name, tool_input: input.data.tool_input }, systemPathEnv());
    return verdict.verdict === 'deny' ? deny(verdict.reason) : { code: 0 };
  } catch {
    return deny('briefstack improvement guard: the check failed, so nothing is allowed.');
  }
}

const SELF = fileURLToPath(import.meta.url);

/** How Claude Code starts this hook: the running Node, no shell; through tsx when run from the sources. */
export function improveGuardCommandLine(rulesFile: string): { command: string; args: string[] } {
  if (SELF.endsWith('.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    return { command: process.execPath, args: ['--import', loader, SELF, rulesFile] };
  }
  return { command: process.execPath, args: [SELF, rulesFile] };
}

/** The `settings` passed to `query()`: this hook on every tool, failing closed. */
export function improveGuardSettings(rulesFile: string): { hooks: { PreToolUse: unknown[] } } {
  const { command, args } = improveGuardCommandLine(rulesFile);
  return {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command, args, onFailure: 'block', timeout: IMPROVE_GUARD_TIMEOUT_S }] }],
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const rulesFile = process.argv[2];
  const verdict =
    rulesFile === undefined || !path.isAbsolute(rulesFile)
      ? deny('briefstack improvement guard: started without its rules file.')
      : await decideImproveToolUse(await readStdin(), rulesFile);
  if (verdict.message !== undefined) process.stderr.write(`${verdict.message}\n`);
  process.exitCode = verdict.code;
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

if (process.argv[1] !== undefined && samePath(path.resolve(process.argv[1]), SELF)) {
  main().catch(() => {
    process.stderr.write('briefstack improvement guard: the check failed, so nothing is allowed.\n');
    process.exitCode = 2;
  });
}

// Shared helpers for the real-session checks of phase 2 (PLAN-phase-2.md,
// "Real runs"). These scripts START REAL CLAUDE CODE SESSIONS with the user's
// own login and spend a little of their plan. They are never run by the test
// suite or by CI; the user runs them on purpose, from PowerShell:
//
//   npx tsx scripts/real/<script>.ts --yes
//
// Each one works in a temp folder it creates (including a temp BRIEFSTACK_HOME)
// and deletes it at the end. None touches the real library or projects.

import type { HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findClaudeExecutable } from '../../src/creation/claudeBinary.js';
import { readPlanUsage as readPlanUsageIn, type PlanUsage } from '../../src/creation/planUsage.js';
import { cleanEnvironment } from '../../src/creation/sdkRunner.js';

/** The scripts do nothing without `--yes`, so a stray run spends no tokens. */
export function requireConfirmation(description: string): void {
  if (process.argv.includes('--yes')) return;
  console.error(`${description}\n\nThis starts a real Claude Code session with your login and uses part of your plan.`);
  console.error('Run it again with --yes to go ahead.');
  process.exit(2);
}

export interface Sandbox {
  dir: string;
  /** A temp BRIEFSTACK_HOME. */
  home: string;
  /** The working folder of the session: not the repo, not a real project. */
  project: string;
  projects: string;
  sessions: string;
  cleanup(): Promise<void>;
}

export async function sandbox(prefix: string): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `briefstack-real-${prefix}-`));
  const made = {
    dir,
    home: path.join(dir, 'home'),
    project: path.join(dir, 'project'),
    projects: path.join(dir, 'projects'),
    sessions: path.join(dir, 'home', 'sessions'),
  };
  for (const folder of [made.home, made.project, made.projects, made.sessions]) await mkdir(folder, { recursive: true });
  return {
    ...made,
    // Windows keeps a folder locked for a while after a session closes: retry.
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }),
  };
}

export function claudeExecutable(): string {
  const executable = findClaudeExecutable({ env: process.env, platform: process.platform, homedir: os.homedir() });
  if (executable === undefined) {
    console.error('Claude Code was not found on PATH or in ~/.local/bin.');
    process.exit(1);
  }
  return executable;
}

/** The environment of a session: no API key, no CLAUDE_CODE_*, the sandbox as BRIEFSTACK_HOME. */
export function sessionEnv(box: Sandbox): Record<string, string | undefined> {
  const { env, removed } = cleanEnvironment(process.env, box.home);
  if (removed.length > 0) console.log(`Not passed to Claude Code: ${removed.join(', ')}`);
  return env;
}

export type { PlanUsage } from '../../src/creation/planUsage.js';

/**
 * Reads the plan usage the way `/usage` does, from a session that sends no
 * message (so it costs nothing). The same reading the web server records
 * during a creation (`src/creation/planUsage.ts`).
 */
export function readPlanUsage(box: Sandbox, executable: string): Promise<PlanUsage | string> {
  return readPlanUsageIn({ cwd: box.project, executable, env: sessionEnv(box) });
}

export function show(usage: PlanUsage | string): string {
  return typeof usage === 'string' ? usage : `5-hour window ${usage.fiveHour ?? '?'}%, 7-day window ${usage.sevenDay ?? '?'}%`;
}

/**
 * The `git status` the preflight runs. `--no-optional-locks` keeps git from
 * refreshing the index, so even in the real repo and library nothing is written.
 */
export const GIT_STATUS_ARGS: readonly string[] = ['--no-optional-locks', 'status', '--porcelain'];

/**
 * A `canUseTool` that allows one shell command, character for character, and
 * denies everything else: another command, a chained one, another tool.
 */
export function onlyThisCommand(expected: string): (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult> {
  return async (toolName, input) => {
    const command = typeof input.command === 'string' ? input.command.trim() : undefined;
    if ((toolName === 'Bash' || toolName === 'PowerShell') && command === expected) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: 'This check allows only the one command it asked for.' };
  };
}

/**
 * A `Stop` hook that keeps the effort Claude Code applied to the turn. The
 * init message of an SDK session does not carry it (the field is only on
 * Remote Control frames), but hook inputs in a tool-use context, `Stop`
 * among them, carry `effort.level` after any downgrade for the model.
 */
export function effortRecorder(): { hook: HookCallback; level: () => string | undefined } {
  let level: string | undefined;
  return {
    hook: async (input) => {
      const reported = (input as { effort?: { level?: unknown } }).effort?.level;
      if (input.hook_event_name === 'Stop' && typeof reported === 'string' && reported !== '') level = reported;
      return {};
    },
    level: () => level,
  };
}

export function report(name: string, passed: boolean, detail: string): boolean {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  return passed;
}

/** A prompt that stays open until `close()`, so the session can be driven by hand. */
export function oneShot(text: string): AsyncIterable<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
}> {
  let sent = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        sent
          ? new Promise(() => undefined)
          : ((sent = true), Promise.resolve({ value: { type: 'user' as const, message: { role: 'user' as const, content: text }, parent_tool_use_id: null }, done: false })),
    }),
  };
}

/** The line the interviewer check asks for at the end of the report. */
export interface InterviewerTarget {
  target: 'claude-code' | 'claude-app';
  rule: string;
}

/**
 * Reads the last `TARGET: <target> | RULE: <cited rule>` line of an
 * interviewer report. Undefined when there is none or the target is not one
 * of the two.
 */
export function parseInterviewerTarget(report: string): InterviewerTarget | undefined {
  const lines = [...report.matchAll(/^\s*`?TARGET:\s*(claude-code|claude-app)\s*\|\s*RULE:\s*(.+?)`?\s*$/gm)];
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  return { target: last[1] as InterviewerTarget['target'], rule: (last[2] ?? '').trim() };
}

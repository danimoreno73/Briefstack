import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter/index.js';
import { declaresHooks, isDefinitionFile, SKILL_TOOL, TASK_BUILTIN_TOOLS } from './guard.js';
import { taskGuardHooks } from './guardCommand.js';
import { fileAtCommit, trackedFiles } from './git.js';

/**
 * What a task session is given, apart from the runner's own options
 * (BRIEF-phase-7 §3.2; PLAN-phase-7 §1; decisions.md, "Phase 7: H0" and
 * "Phase 7: skills that are not the project's").
 */

/** Why a project definition stops a task from starting. */
export type UnsafeReason = 'hooks' | 'mcpServers' | 'permissionMode' | 'foreignSkills' | 'unreadable' | 'settings';

export interface UnsafeDefinition {
  file: string;
  reason: UnsafeReason;
}

export interface ProjectInspection {
  /** The project's own skills and commands: the SDK `skills` option and the guard's list. */
  skills: string[];
  /** Definitions that stop the task (hooks, MCP servers, a permission mode, other skills preloaded). */
  unsafe: UnsafeDefinition[];
  /** Agents whose `tools` name nothing the task offers: Claude Code would refuse them ("zero tools"). */
  agentsWithoutTools: string[];
  /** `@` imports in the project's `CLAUDE.md` files and rules that point outside the worktree (they do not load in a task: M0). */
  externalImports: { file: string; target: string }[];
}

const listOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item !== '');
  if (typeof value === 'string') return value.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item !== '');
  return [];
};

/** `Bash(npm *)` names the tool `Bash`. */
const toolNameOf = (entry: string): string => entry.replace(/\(.*$/, '').trim();

const IMPORT_RE = /(?:^|\s)@((?:~|\.{1,2}|[A-Za-z]:|[\\/])?[^\s`'"<>)]*)/g;

/** The `@` imports of a memory file outside code spans and fences, as written. */
export function importsOf(text: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, '');
    for (const match of plain.matchAll(IMPORT_RE)) {
      const target = match[1] ?? '';
      if (target !== '' && /[\\/.]/.test(target)) found.push(target);
    }
  }
  return found;
}

const isMemoryFile = (file: string): boolean => {
  const name = file.split('/').at(-1) ?? '';
  return /^(CLAUDE|AGENTS)\.md$/i.test(name) || /(^|\/)\.claude\/rules\/.+\.md$/i.test(file);
};

/**
 * Reads the project as the worktree has it: its skills and commands, the
 * definitions that stop a task, agents with no usable tool, and imports
 * that point outside the worktree. At the start the tracked files are all
 * there is; before a later round `files` holds every file, ignored ones too
 * (`allFiles`), since a shell command the user allowed may have left a
 * definition git does not track. A `.claude/settings.json` in the worktree
 * (hidden there at the start, so only a later command can make one) is
 * unsafe too: the next session would load its hooks.
 */
export async function inspectProject(worktree: string, options: { files?: readonly string[] } = {}): Promise<ProjectInspection> {
  const files = options.files ?? (await trackedFiles(worktree));
  const skills = new Set<string>();
  const unsafe: UnsafeDefinition[] = [];
  const agentsWithoutTools: string[] = [];
  const externalImports: { file: string; target: string }[] = [];
  const definitions: { file: string; data: Record<string, unknown>; kind: string }[] = [];
  const offered = new Set<string>([...TASK_BUILTIN_TOOLS, SKILL_TOOL]);

  for (const file of files) {
    const native = path.join(worktree, ...file.split('/'));
    if (isDefinitionFile(file)) {
      let content: string;
      try {
        content = await readFile(native, 'utf8');
      } catch {
        unsafe.push({ file, reason: 'unreadable' });
        continue;
      }
      if (declaresHooks(content)) {
        unsafe.push({ file, reason: 'hooks' });
        continue;
      }
      let data: Record<string, unknown>;
      try {
        ({ data } = parseFrontmatter(content, file));
      } catch {
        unsafe.push({ file, reason: 'unreadable' });
        continue;
      }
      const segments = file.split('/');
      const kind = segments[segments.lastIndexOf('.claude') + 1] ?? '';
      definitions.push({ file, data, kind });
      if (kind === 'skills' && segments.at(-1) === 'SKILL.md') {
        const folder = segments.at(-2);
        if (folder !== undefined) skills.add(folder);
        if (typeof data.name === 'string' && data.name.trim() !== '') skills.add(data.name.trim());
      }
      if (kind === 'commands') {
        skills.add((segments.at(-1) ?? '').replace(/\.md$/i, ''));
        if (typeof data.name === 'string' && data.name.trim() !== '') skills.add(data.name.trim());
      }
    } else if (isMemoryFile(file)) {
      let content: string;
      try {
        content = await readFile(native, 'utf8');
      } catch {
        continue;
      }
      for (const target of importsOf(content)) {
        const expanded = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
        const resolved = path.resolve(path.dirname(native), expanded);
        const relative = path.relative(worktree, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) externalImports.push({ file, target });
      }
    }
  }

  for (const { file, data, kind } of definitions) {
    if (kind !== 'agents') continue;
    if (data.mcpServers !== undefined) unsafe.push({ file, reason: 'mcpServers' });
    const mode = data.permissionMode;
    if (mode !== undefined && mode !== 'default' && mode !== 'plan') unsafe.push({ file, reason: 'permissionMode' });
    const preload = listOf(data.skills);
    if (preload.some((name) => !skills.has(name))) unsafe.push({ file, reason: 'foreignSkills' });
    const tools = listOf(data.tools).map(toolNameOf);
    if (tools.length > 0 && !tools.some((tool) => offered.has(tool) || tool === '*')) agentsWithoutTools.push(file);
  }

  try {
    await stat(path.join(worktree, '.claude', 'settings.json'));
    unsafe.push({ file: '.claude/settings.json', reason: 'settings' });
  } catch {
    // Not there, as the worktree was made.
  }

  return { skills: [...skills].sort(), unsafe, agentsWithoutTools, externalImports };
}

/**
 * The project's own `deny` and `ask` rules from its committed
 * `.claude/settings.json` at the task's base commit. The file is hidden in
 * the worktree, so these only restrict, passed in the task's flag settings;
 * allow rules, `defaultMode`, extra folders, hooks and `env` are never read.
 */
export async function projectRestrictions(projectDir: string, baseCommit: string): Promise<{ deny: string[]; ask: string[] }> {
  const raw = await fileAtCommit(projectDir, baseCommit, '.claude/settings.json');
  if (raw === undefined) return { deny: [], ask: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { deny: [], ask: [] };
  }
  const permissions = (typeof data === 'object' && data !== null ? (data as { permissions?: unknown }).permissions : undefined) as Record<string, unknown> | undefined;
  const rules = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 500) : []);
  return { deny: rules(permissions?.deny), ask: rules(permissions?.ask) };
}

/** Memory files Claude Code loads from a folder: `CLAUDE.md` and `AGENTS.md` in it and in its `.claude/`, `CLAUDE.local.md`, and its rules. */
const MEMORY_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md'), path.join('.claude', 'AGENTS.md'), path.join('.claude', 'rules', '**')];

/**
 * `claudeMdExcludes` for every folder above the worktree, up to the root,
 * so the user's own files around `<home>/tasks/` never reach the session
 * (B8; `AGENTS.md` too: decisions.md, "Phase 7: skills that are not the
 * project's"). Patterns match absolute paths with glob syntax: each one is
 * given as the system writes it and with forward slashes.
 */
export function excludesAbove(worktree: string): string[] {
  const patterns = new Set<string>();
  let dir = path.dirname(path.resolve(worktree));
  for (;;) {
    for (const name of MEMORY_NAMES) {
      const file = path.join(dir, name);
      patterns.add(file);
      patterns.add(file.split(path.sep).join('/'));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...patterns];
}

/** Environment variables a task session gets on top of a creation's clean environment. */
export const TASK_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
};

/** The built-in plugin that brings the `plugin-authoring` skill (decisions.md, "Phase 7: skills that are not the project's"). */
export const BUILTIN_PLUGINS_OFF: Readonly<Record<string, boolean>> = { 'cc-plugin-plugin-authoring@builtin': false };

export interface TaskSettingsParams {
  worktree: string;
  rulesFile: string;
  restrictions: { deny: string[]; ask: string[] };
}

/**
 * The task's flag settings (the SDK `settings` option): the command-hook
 * guard, the project's deny and ask rules, the memory files above the
 * worktree left out, Claude Code's bundled skills and the built-in
 * `plugin-authoring` plugin off, and no inline shell in skills.
 * `disableAllHooks` is not set: it also stops the command-hook guard (M0).
 */
export function taskFlagSettings(params: TaskSettingsParams): Record<string, unknown> {
  const { deny, ask } = params.restrictions;
  return {
    hooks: taskGuardHooks(params.rulesFile),
    ...(deny.length > 0 || ask.length > 0 ? { permissions: { ...(deny.length > 0 ? { deny } : {}), ...(ask.length > 0 ? { ask } : {}) } } : {}),
    claudeMdExcludes: excludesAbove(params.worktree),
    disableBundledSkills: true,
    disableSkillShellExecution: true,
    enabledPlugins: { ...BUILTIN_PLUGINS_OFF },
  };
}

/** The task's closed tool list: `Skill` only when the project has skills. */
export function taskTools(skills: readonly string[]): string[] {
  return skills.length > 0 ? [...TASK_BUILTIN_TOOLS, SKILL_TOOL] : [...TASK_BUILTIN_TOOLS];
}

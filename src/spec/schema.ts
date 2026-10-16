import { z } from 'zod';
import { isDocumentPath } from './preparation.js';

/**
 * The project spec: written by the architect, approved by the user, read by
 * `briefstack scaffold`. `schemas/spec.schema.json` is generated from this.
 */

export const PROJECT_TYPES = ['software', 'learning-or-management', 'generic'] as const;
export const TARGETS = ['claude-code', 'claude-app'] as const;
export const TIERS = ['light', 'standard', 'heavy'] as const;
/** Who chose the target: the user, or the architect by `library/rules/target.md`. */
export const TARGET_CHOOSERS = ['user', 'architect'] as const;

/**
 * Rules of our own. Issues that break one carry the rule name so the i18n
 * catalogue can explain it; zod's built-in checks use zod's own (localised)
 * messages.
 */
export const SPEC_RULES = [
  'slug',
  'safePath',
  'reservedPath',
  'toolName',
  'noAgentTool',
  'duplicate',
  'claudeCodeOnly',
  'documentOnly',
] as const;
export type SpecRule = (typeof SPEC_RULES)[number];

const rule = (name: SpecRule) => ({ params: { rule: name } });

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A regex (not a refine) so the pattern shows in the JSON Schema; zod drops
// `params` on regex checks, so the issue is recognised by its pattern instead.
const slug = z.string().max(64).regex(SLUG_RE);

const text = z.string().trim().min(1);

// Windows forbids these in file names; keeping specs portable means refusing
// them everywhere.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/** A portable relative path: `/` separators, no `..`, nothing Windows rejects. */
export function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      !INVALID_CHARS.test(segment) &&
      !WINDOWS_RESERVED.test(segment) &&
      !/[. ]$/.test(segment),
  );
}

/** Paths the scaffolder owns; a spec may not place files there. */
export function isReservedPath(value: string): boolean {
  const lower = value.toLowerCase();
  const first = lower.split('/')[0];
  return (
    first === '.git' ||
    first === '.briefstack' ||
    lower === '.gitignore' ||
    lower === '.claude/settings.json' ||
    lower === '.claude/settings.local.json' ||
    lower.startsWith('.claude/agents/') ||
    lower.startsWith('.claude/skills/')
  );
}

const relativePath = z
  .string()
  .refine(isSafeRelativePath, rule('safePath'))
  .refine((value) => !isReservedPath(value), rule('reservedPath'));

// Built-in names such as `Read` or `Bash(npm test:*)`, or MCP tools.
const TOOL_RE = /^(?:[A-Z][A-Za-z]*(?:\(.+\))?|mcp__[\w-]+(?:__[\w-]+)?)$/;
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const tool = z
  .string()
  .refine((value) => TOOL_RE.test(value), rule('toolName'))
  .refine((value) => !SPAWN_TOOLS.has(value.replace(/\(.*$/, '')), rule('noAgentTool'));

export const SkillSpecSchema = z.strictObject({
  name: slug,
  description: text,
  purpose: text.optional(),
});

export const AgentSpecSchema = z.strictObject({
  name: slug,
  description: text,
  tools: z.array(tool).min(1),
  tier: z.enum(TIERS),
  purpose: text.optional(),
});

export const ScheduledTaskSpecSchema = z.strictObject({
  name: text,
  /** Human wording, e.g. "every Monday at 09:00"; the user sets it up by hand. */
  schedule: text,
  prompt: text,
});

/** briefstack writes documents only; the project's code is written later, inside the project. */
export const FileSpecSchema = z.strictObject({
  path: relativePath.refine(isDocumentPath, rule('documentOnly')),
  purpose: text,
});

function addDuplicateIssues(
  ctx: z.core.$RefinementCtx,
  values: readonly string[],
  path: (string | number)[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    // Case-insensitive: Windows and macOS would collide on these.
    const key = value.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: [...path, index], params: { rule: 'duplicate' } });
    }
    seen.add(key);
  });
}

export const SpecSchema = z
  .strictObject({
    specVersion: z.literal(1),
    name: text.max(100),
    slug,
    summary: text,
    /** Language of the generated content, as a BCP 47 tag such as `en` or `es`. */
    language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    type: z.enum(PROJECT_TYPES),
    /** Template name; defaults to `type`. Personal templates win over base ones. */
    template: slug.optional(),
    target: z.enum(TARGETS),
    /** Who chose the target. Optional so specs written before it stay valid. */
    targetChosenBy: z
      .enum(TARGET_CHOOSERS)
      .optional()
      .describe('Who chose the target: `user` (stated it or answered the question) or `architect` (by library/rules/target.md).'),
    /** Why this target: the user's reason when they chose, the rule's when the architect did. */
    targetReason: text.optional(),
    /** Usage profile the project is created with. */
    profile: text,
    goal: text,
    audience: text,
    deliverables: z
      .array(text)
      .min(1)
      .describe(
        'What the project will produce over its life. Written into the brief; briefstack does not build them.',
      ),
    constraints: z.array(text).default([]),
    doneWhen: z
      .array(text)
      .min(1)
      .describe(
        'When the project itself is finished. Written into the brief; not a check of the folder briefstack prepares.',
      ),
    directories: z.array(relativePath).default([]).describe('Empty folders that give the project its structure.'),
    files: z
      .array(FileSpecSchema)
      .default([])
      .describe(
        'Documents briefstack writes to prepare the project (.md, .txt, .csv): context, notes, at most a first task plan. Never application code, tests or build files.',
      ),
    skills: z.array(SkillSpecSchema).default([]),
    agents: z.array(AgentSpecSchema).default([]),
    scheduledTasks: z.array(ScheduledTaskSpecSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    addDuplicateIssues(ctx, spec.directories, ['directories']);
    addDuplicateIssues(
      ctx,
      spec.files.map((file) => file.path),
      ['files'],
    );
    addDuplicateIssues(
      ctx,
      spec.skills.map((skill) => skill.name),
      ['skills'],
    );
    addDuplicateIssues(
      ctx,
      spec.agents.map((agent) => agent.name),
      ['agents'],
    );
    if (spec.target !== 'claude-code') {
      for (const field of ['skills', 'agents'] as const) {
        if (spec[field].length > 0) {
          ctx.addIssue({ code: 'custom', path: [field], params: { rule: 'claudeCodeOnly' } });
        }
      }
    }
  });

/** A spec after defaults are applied. */
export type Spec = z.output<typeof SpecSchema>;
/** A spec as written in `spec.json`. */
export type SpecInput = z.input<typeof SpecSchema>;
export type AgentSpec = z.output<typeof AgentSpecSchema>;
export type SkillSpec = z.output<typeof SkillSpecSchema>;
export type Tier = (typeof TIERS)[number];
export type Target = (typeof TARGETS)[number];
export type TargetChooser = (typeof TARGET_CHOOSERS)[number];

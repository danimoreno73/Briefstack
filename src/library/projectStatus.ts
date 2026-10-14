import { z } from 'zod';
import { buildFrontmatter, parseFrontmatter, setFrontmatterFields } from '../frontmatter/index.js';
import { isSessionId } from '../events/index.js';
import { SLUG_RE, TARGETS } from '../spec/schema.js';

/**
 * The status block of a project note in `projects/<slug>.md`: the note's
 * YAML frontmatter, one scalar per line, so Obsidian shows it as properties
 * and later phases can parse it. Format version 1:
 *
 *     ---
 *     statusFormat: 1
 *     slug: garden-planner
 *     target: claude-code
 *     path: <absolute path of the generated project>
 *     status: created
 *     profile: balanced
 *     updated: 2026-10-12
 *     created: 2026-10-12
 *     session: 3f2c9a7e-0b1d-4c55-9e1a-2b7d8c0f4e61
 *     summary: Plan a vegetable garden across seasons.
 *     ---
 *
 * `updated` is written by briefstack (UTC date of the last change).
 * `created` (UTC date the note was created) and `session` (the id of the
 * creation session, which links the project to its timeline) are optional:
 * notes written before phase 2 have neither and stay valid.
 */

export const STATUS_FORMAT = 1;
export const PROJECT_STATUSES = ['created', 'active', 'paused', 'done', 'abandoned'] as const;
export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const oneLine = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), 'single line');

export const projectStatusSchema = z.object({
  statusFormat: z.literal(STATUS_FORMAT),
  slug: z.string().regex(SLUG_RE),
  target: z.enum(TARGETS),
  path: oneLine,
  status: z.enum(PROJECT_STATUSES),
  profile: z.string().regex(SLUG_RE),
  updated: z.string().regex(ISO_DATE_RE),
  created: z.string().regex(ISO_DATE_RE).optional(),
  session: z.string().refine(isSessionId, 'session id').optional(),
  summary: oneLine,
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/** Fields a caller may set; `statusFormat`, `slug`, `updated`, `created` and `session` are briefstack's. */
export const PROJECT_STATUS_INPUT_FIELDS = ['target', 'path', 'status', 'profile', 'summary'] as const;
export type ProjectStatusInput = Partial<Pick<ProjectStatus, (typeof PROJECT_STATUS_INPUT_FIELDS)[number]>>;

const FIELD_ORDER: readonly (keyof ProjectStatus)[] = [
  'statusFormat',
  'slug',
  'target',
  'path',
  'status',
  'profile',
  'updated',
  'created',
  'session',
  'summary',
];

/** Issues as `field: message`, for coded errors. */
export function statusIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function asStrings(status: ProjectStatus): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of FIELD_ORDER) {
    const value = status[key];
    if (value !== undefined) fields[key] = String(value);
  }
  return fields;
}

/** A new project note: the status block followed by `body`. */
export function writeProjectNote(status: ProjectStatus, body: string): string {
  const fields = asStrings(projectStatusSchema.parse(status));
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'statusFormat'));
  // `statusFormat` is written as a YAML number, the other fields as strings.
  return buildFrontmatter(rest, body).replace(/^---\n/, `---\nstatusFormat: ${STATUS_FORMAT}\n`);
}

/** Rewrites the status fields of an existing note, keeping everything else. */
export function updateProjectNote(text: string, status: ProjectStatus, file: string): string {
  const fields = asStrings(projectStatusSchema.parse(status));
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'statusFormat'));
  return setFrontmatterFields(text, rest, file);
}

export type ReadStatusResult =
  | { ok: true; status: ProjectStatus }
  | { ok: false; issues: string[] };

/** Reads the status block of a project note. */
export function readProjectStatus(text: string, file: string): ReadStatusResult {
  const { data } = parseFrontmatter(text, file);
  const normalised: Record<string, unknown> = { ...data };
  // YAML may read a bare date as a Date and a slug made of digits as a number.
  for (const key of ['updated', 'created', 'session', 'slug', 'profile', 'path', 'summary'] as const) {
    const value = normalised[key];
    if (value instanceof Date) normalised[key] = value.toISOString().slice(0, 10);
    else if (typeof value === 'number') normalised[key] = String(value);
  }
  const result = projectStatusSchema.safeParse(normalised);
  return result.success ? { ok: true, status: result.data } : { ok: false, issues: statusIssues(result.error) };
}

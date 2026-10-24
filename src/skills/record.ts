import { stringify } from 'yaml';
import { z } from 'zod';
import { parseFrontmatter } from '../frontmatter/index.js';
import { SLUG_RE } from '../spec/schema.js';
import { redactSecretLines } from '../validate/secrets.js';
import { FINDING_RULES, type InventoryItem, type LicenseInfo, type ReviewFinding, type StaticReview } from './review.js';
import type { ModelReview } from './modelReview.js';

/**
 * The metadata note of a library skill, `skills/<name>/<name>.md`
 * (BRIEF-phase-6 §3.2): YAML frontmatter that briefstack reads back, and a
 * body for people (Obsidian shows both). Everything in it that came from
 * the skill (description, excerpts) has secrets hidden and is kept short.
 *
 * The skill's files sit next to it: `files/` (the current version) and,
 * while an update waits for approval, `next/`.
 */

export const SKILL_FORMAT = 1;
export const SKILL_STATUSES = ['quarantine', 'approved', 'rejected'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const FILES_DIR = 'files';
export const NEXT_DIR = 'next';
export const MAX_DESCRIPTION = 1024;
export const MAX_TAGS = 10;
export const TAG_RE = /^[\p{Ll}\p{N}]+(?:-[\p{Ll}\p{N}]+)*$/u;
export const MAX_TAG_LENGTH = 30;

/** Names Claude Code skips or reserves (docs/decisions.md, phase 6 H0 point 4). */
const RESERVED_NAMES = new Set(['synced', 'anthropic-skills', 'files', 'next']);

export function isSkillName(name: string): boolean {
  return name.length <= 64 && SLUG_RE.test(name) && !RESERVED_NAMES.has(name) && !name.startsWith('anthropic-skills');
}

/** A library name from the skill's own name or its folder: lower case, letters, digits and hyphens. */
export function skillNameFrom(candidates: readonly (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (raw === undefined) continue;
    const name = raw
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '');
    if (name !== '' && isSkillName(name)) return name;
  }
  return undefined;
}

/** One line, no control characters, secrets hidden, at most `max` characters. */
export function cleanLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const line = redactSecretLines(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const iso = z.string().min(10).max(40);

export const sourceSchema = z.object({
  /** The link as the user gave it. */
  url: z.string().max(2000),
  /** `owner/repo`. */
  repo: z.string().max(200),
  /** The folder in the repo, with `/`; empty for the root. */
  path: z.string().max(1000),
  /** The ref that was asked for (`HEAD` for the default branch). */
  ref: z.string().max(300),
  commit: sha40,
  /** The folder at the pinned commit on github.com. */
  link: z.string().max(2400),
});
export type SkillSource = z.infer<typeof sourceSchema>;

const fileSchema = z.object({
  path: z.string().max(400),
  size: z.number().int().min(0),
  kind: z.enum(['markdown', 'script', 'binary', 'other']),
  sha256: sha256Schema,
  executable: z.boolean(),
});

const findingSchema = z.object({
  rule: z.enum(FINDING_RULES),
  severity: z.enum(['high', 'medium', 'low', 'info']),
  file: z.string().max(400),
  line: z.number().int().min(1).optional(),
  excerpt: z.string().max(400).optional(),
});

const licenseSchema = z.object({
  spdx: z.string().max(80).nullable(),
  source: z.enum(['file', 'frontmatter', 'header', 'repo', 'none']),
  file: z.string().max(400).optional(),
});

const modelSchema = z.object({
  state: z.enum(['flagged', 'clear', 'unavailable']),
  reason: z.string().max(4000),
  model: z.string().max(80),
  at: iso,
});

/** One fetched version: what it is, where it came from and what the review found. */
export const versionSchema = z.object({
  description: z.string().max(MAX_DESCRIPTION + 10),
  source: sourceSchema,
  fetched: iso,
  license: licenseSchema,
  hasScripts: z.boolean(),
  network: z.boolean(),
  /** `allowed-tools` as SKILL.md declares it, if it does. */
  allowedTools: z.string().max(400).optional(),
  files: z.array(fileSchema).max(1000),
  findings: z.array(findingSchema).max(400),
  model: modelSchema,
});
export type SkillVersion = z.infer<typeof versionSchema>;

export const recordSchema = versionSchema.extend({
  skillFormat: z.literal(SKILL_FORMAT),
  name: z.string().refine(isSkillName),
  status: z.enum(SKILL_STATUSES),
  tags: z.array(z.string().max(MAX_TAG_LENGTH).regex(TAG_RE)).max(MAX_TAGS),
  /** When the status last changed (ISO date-time). */
  statusChanged: iso,
  /** A newer version in quarantine, waiting for approval. */
  next: versionSchema.optional(),
});
export type SkillRecord = z.infer<typeof recordSchema>;

/** A version from a fetch and its reviews. */
export function versionFrom(params: {
  source: SkillSource;
  fetched: string;
  review: StaticReview;
  model: ModelReview;
}): SkillVersion {
  const { review } = params;
  const version: SkillVersion = {
    description: cleanLine(review.frontmatter.description ?? '', MAX_DESCRIPTION),
    source: params.source,
    fetched: params.fetched,
    license: licenseOf(review.license),
    hasScripts: review.hasScripts,
    network: review.network,
    files: review.inventory.map((item: InventoryItem) => ({ path: item.path, size: item.size, kind: item.kind, sha256: item.sha256, executable: item.executable })),
    findings: review.findings.map(cleanFinding),
    model: { ...params.model, reason: cleanLine(params.model.reason, 3000) },
  };
  if (review.frontmatter.allowedTools !== undefined && review.frontmatter.allowedTools !== '') version.allowedTools = cleanLine(review.frontmatter.allowedTools, 400);
  return version;
}

function licenseOf(license: LicenseInfo): SkillVersion['license'] {
  return { spdx: license.spdx, source: license.source, ...(license.file === undefined ? {} : { file: license.file }) };
}

function cleanFinding(finding: ReviewFinding): SkillVersion['findings'][number] {
  return {
    rule: finding.rule,
    severity: finding.severity,
    file: finding.file,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.excerpt === undefined ? {} : { excerpt: cleanLine(finding.excerpt, 200) }),
  };
}

const short = (sha: string): string => sha.slice(0, 7);
/** Text from a skill inside inline code: no backticks, so it cannot close the span. */
const code = (text: string): string => `\`${text.replaceAll('`', "'")}\``;

function versionBody(version: SkillVersion, heading: string): string[] {
  const s = version.source;
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of version.findings) counts[finding.severity] += 1;
  const lines = [
    `## ${heading}`,
    '',
    `- Source: <${s.link}> (${code(s.repo)}${s.path === '' ? '' : ` ${code(s.path)}`} at ${code(short(s.commit))}, asked as ${code(s.ref)})`,
    `- Fetched: ${version.fetched.slice(0, 10)}`,
    `- License: ${version.license.spdx ?? (version.license.source === 'none' ? 'none found' : 'not recognised')}${version.license.file === undefined ? '' : ` (${code(version.license.file)})`}`,
    `- Scripts: ${version.hasScripts ? 'yes' : 'no'}; network: ${version.network ? 'yes' : 'no'}${version.allowedTools === undefined ? '' : `; allowed-tools: ${code(version.allowedTools)}`}`,
    `- Findings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info`,
    `- Model review (${version.model.model}): ${version.model.state}. ${cleanLine(version.model.reason, 600)}`,
    '',
    '### Findings',
    '',
    ...(version.findings.length === 0
      ? ['None.']
      : version.findings.map((f) => `- ${f.severity}: ${f.rule} in ${code(f.file === '' ? '(skill)' : `${f.file}${f.line === undefined ? '' : `:${f.line}`}`)}${f.excerpt === undefined ? '' : ` ${code(f.excerpt)}`}`)),
    '',
    '### Files',
    '',
    ...version.files.map((f) => `- ${code(f.path)}: ${f.kind}, ${f.size} bytes, sha256 ${code(f.sha256.slice(0, 12))}`),
    '',
  ];
  return lines;
}

/** The whole note: frontmatter, then the readable summary. */
export function renderRecord(record: SkillRecord): string {
  const checked = recordSchema.parse(record);
  const yaml = stringify(checked, { lineWidth: 0 });
  const body = [
    `# ${checked.name}`,
    '',
    checked.description === '' ? '(No description.)' : checked.description,
    '',
    `Status: **${checked.status}**${checked.tags.length === 0 ? '' : `. Tags: ${checked.tags.map(code).join(', ')}`}.`,
    'Third-party skill kept by briefstack. The files under `files/` are exactly as fetched; briefstack never runs them.',
    '',
    ...versionBody(checked, 'Current version'),
    ...(checked.next === undefined ? [] : versionBody(checked.next, 'New version in quarantine')),
  ];
  return `---\n${yaml}---\n${body.join('\n')}`;
}

/** Reads a note back; `undefined` when it is not a valid skill note. */
export function parseRecord(text: string, file: string): SkillRecord | undefined {
  try {
    const { hasFrontmatter, data } = parseFrontmatter(text, file);
    if (!hasFrontmatter) return undefined;
    const parsed = recordSchema.safeParse(data);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

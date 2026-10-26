import { readFile } from 'node:fs/promises';
import { toJSONSchema, type core } from 'zod';
import { BriefstackError } from '../errors.js';
import { SLUG_RE, SPEC_RULES, SpecSchema, type Spec, type SpecRule } from './schema.js';

export * from './preparation.js';
export * from './schema.js';
export * from './tools.js';

/** One problem in a spec. `rule` is set for briefstack's own rules. */
export interface SpecIssue {
  /** Dotted path such as `agents.0.tools.1`; empty for the root. */
  path: string;
  rule?: SpecRule;
  /** For `unknownTool` and `retiredTool`: the tool named, and the one to use instead when there is one. */
  tool?: string;
  replacement?: string;
  /** zod's message, in whatever locale zod is configured with. */
  message: string;
}

function toIssue(issue: core.$ZodIssue): SpecIssue {
  const path = issue.path.map(String).join('.');
  const isSlug = issue.code === 'invalid_format' && issue.pattern === String(SLUG_RE);
  const params = (issue as { params?: { rule?: unknown; tool?: unknown; replacement?: unknown } }).params;
  const candidate = isSlug ? 'slug' : params?.rule;
  const rule = SPEC_RULES.find((name) => name === candidate);
  if (rule === undefined) return { path, message: issue.message };
  return {
    path,
    rule,
    ...(typeof params?.tool === 'string' ? { tool: params.tool } : {}),
    ...(typeof params?.replacement === 'string' ? { replacement: params.replacement } : {}),
    message: issue.message,
  };
}

/** Validates parsed JSON and applies defaults. `file` is for error messages. */
export function parseSpec(data: unknown, file: string): Spec {
  const result = SpecSchema.safeParse(data);
  if (!result.success) {
    throw new BriefstackError('spec.invalid', { file, issues: result.error.issues.map(toIssue) });
  }
  return result.data;
}

export async function readSpec(file: string): Promise<Spec> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BriefstackError('spec.notFound', { file }, { cause: error });
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new BriefstackError(
      'spec.invalidJson',
      { file, detail: error instanceof Error ? error.message : String(error) },
      { cause: error },
    );
  }
  return parseSpec(data, file);
}

/** JSON Schema of the spec as the architect writes it (before defaults). */
export function specJsonSchema(): Record<string, unknown> {
  return toJSONSchema(SpecSchema, { io: 'input' }) as Record<string, unknown>;
}

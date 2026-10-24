import { parseDocument, stringify } from 'yaml';
import { BriefstackError } from '../errors.js';

/** YAML frontmatter between `---` lines at the top of a markdown file. */
export interface Frontmatter {
  hasFrontmatter: boolean;
  data: Record<string, unknown>;
  body: string;
}

const BOM = '\uFEFF';

interface Block {
  /** Everything before the YAML: BOM and the opening `---` line. */
  head: string;
  yaml: string;
  /** The closing `---` line and the body after it. */
  tail: string;
  body: string;
  eol: string;
}

function splitBlock(text: string, file: string): Block | undefined {
  const bom = text.startsWith(BOM) ? BOM : '';
  const rest = text.slice(bom.length);
  const open = /^---[ \t]*(\r?\n)/.exec(rest);
  if (open === null) return undefined;

  const afterOpen = open[0].length;
  const closeRe = /^---[ \t]*(?:\r?\n|$)/gm;
  closeRe.lastIndex = afterOpen;
  const close = closeRe.exec(rest);
  if (close === null) throw new BriefstackError('frontmatter.unclosed', { file });

  const afterClose = close.index + close[0].length;
  return {
    head: bom + open[0],
    yaml: rest.slice(afterOpen, close.index),
    tail: rest.slice(close.index),
    body: rest.slice(afterClose),
    eol: open[1] ?? '\n',
  };
}

function parseYaml(yaml: string, file: string): Record<string, unknown> {
  const doc = parseDocument(yaml);
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    throw new BriefstackError('frontmatter.invalidYaml', { file, detail: firstError.message });
  }
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new BriefstackError('frontmatter.notAMapping', { file });
  }
  return data as Record<string, unknown>;
}

/** `file` is only used in error messages. */
export function parseFrontmatter(text: string, file: string): Frontmatter {
  const block = splitBlock(text, file);
  if (block === undefined) {
    return { hasFrontmatter: false, data: {}, body: text.startsWith(BOM) ? text.slice(1) : text };
  }
  return { hasFrontmatter: true, data: parseYaml(block.yaml, file), body: block.body };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scalar(value: string): string {
  return stringify(value, { lineWidth: 0 }).replace(/\r?\n$/, '');
}

/** A new markdown file with the given string fields as frontmatter. */
export function buildFrontmatter(fields: Readonly<Record<string, string>>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${scalar(value)}\n`);
  return `---\n${lines.join('')}---\n${body}`;
}

/**
 * Removes a top-level scalar field, touching only its own line. A missing
 * field leaves the text as it is; a block value is refused, as in
 * `setFrontmatterFields`.
 */
export function removeFrontmatterField(text: string, key: string, file: string): string {
  const block = splitBlock(text, file);
  if (block === undefined) return text;
  const lines: string[] = [...(block.yaml.match(/[^\n]*\n|[^\n]+$/g) ?? [])];
  const keyRe = new RegExp(`^${escapeRegExp(key)}[ \\t]*:(.*?)(\\r?\\n)?$`);
  const index = lines.findIndex((line) => keyRe.test(line));
  if (index === -1) return text;
  const inline = (keyRe.exec(lines[index] ?? '')?.[1] ?? '').trim();
  const next = lines[index + 1];
  if (inline === '' || inline.startsWith('|') || inline.startsWith('>') || (next !== undefined && /^([ \t]|- |-$)/.test(next))) {
    throw new BriefstackError('frontmatter.blockValue', { file, field: key });
  }
  lines.splice(index, 1);
  const yaml = lines.join('');
  parseYaml(yaml, file);
  return block.head + yaml + block.tail;
}

/**
 * Sets top-level string fields, touching only their own lines. A field that
 * already has the requested value is left byte-for-byte as it was; a missing
 * field is appended at the end of the frontmatter. Everything else in the
 * file, including the body, comments and line endings, is preserved.
 */
export function setFrontmatterFields(
  text: string,
  fields: Readonly<Record<string, string>>,
  file: string,
): string {
  const block = splitBlock(text, file);
  if (block === undefined) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const bom = text.startsWith(BOM) ? BOM : '';
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${scalar(value)}${eol}`);
    return `${bom}---${eol}${lines.join('')}---${eol}${text.slice(bom.length)}`;
  }

  const current = parseYaml(block.yaml, file);
  // Keep each line's own terminator so mixed line endings survive.
  const lines: string[] = [...(block.yaml.match(/[^\n]*\n|[^\n]+$/g) ?? [])];

  for (const [key, value] of Object.entries(fields)) {
    if (current[key] === value) continue;

    const keyRe = new RegExp(`^${escapeRegExp(key)}[ \\t]*:(.*?)(\\r?\\n)?$`);
    const index = lines.findIndex((line) => keyRe.test(line));
    if (index === -1) {
      lines.push(`${key}: ${scalar(value)}${block.eol}`);
      continue;
    }

    const match = keyRe.exec(lines[index] ?? '');
    const inline = (match?.[1] ?? '').trim();
    const next = lines[index + 1];
    const continues = next !== undefined && /^([ \t]|- |-$)/.test(next);
    if (inline === '' || inline.startsWith('|') || inline.startsWith('>') || continues) {
      throw new BriefstackError('frontmatter.blockValue', { file, field: key });
    }
    lines[index] = `${key}: ${scalar(value)}${match?.[2] ?? ''}`;
  }

  const yaml = lines.join('');
  const updated = parseYaml(yaml, file);
  for (const [key, value] of Object.entries(fields)) {
    if (updated[key] !== value) {
      throw new BriefstackError('frontmatter.invalidYaml', { file, detail: key });
    }
  }
  return block.head + yaml + block.tail;
}

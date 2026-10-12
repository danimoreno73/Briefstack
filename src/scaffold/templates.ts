import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import type { Target } from '../spec/index.js';

export interface TemplateFile {
  /** Relative path inside the generated project, with `/` separators. */
  path: string;
  content: string;
}

/** Code-point order, so results do not depend on the locale. */
export const comparePaths = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export interface Template {
  name: string;
  dir: string;
  files: TemplateFile[];
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function readTree(dir: string): Promise<TemplateFile[]> {
  if (!(await isDirectory(dir))) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: TemplateFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, absolute).split(path.sep).join('/');
    files.push({ path: relative, content: await readFile(absolute, 'utf8') });
  }
  return files;
}

/**
 * A template is `<root>/<name>/` with `common/` (always copied) and one
 * folder per target. The first root that has the template wins, so the
 * personal library can shadow a base template.
 */
export async function loadTemplate(
  name: string,
  target: Target,
  roots: readonly string[],
): Promise<Template> {
  for (const root of roots) {
    const dir = path.join(root, name);
    if (!(await isDirectory(dir))) continue;
    const byPath = new Map<string, TemplateFile>();
    for (const part of ['common', target]) {
      for (const file of await readTree(path.join(dir, part))) byPath.set(file.path, file);
    }
    return { name, dir, files: [...byPath.values()].sort(comparePaths) };
  }
  throw new BriefstackError('scaffold.templateNotFound', {
    template: name,
    searched: roots.map((root) => path.join(root, name)),
  });
}

/** Replaces `{{key}}` placeholders; unknown keys are left for the generator. */
export function renderTemplate(content: string, vars: Readonly<Record<string, string>>): string {
  return content.replace(/\{\{\s*([A-Za-z][\w]*)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] as string) : match,
  );
}

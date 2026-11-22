import type { ProjectListing } from './types.js';

/**
 * The projects list as CSV (IDEAS §3, "Projects: Export CSV"; phase 9,
 * step 33), built in the page from `GET /api/projects`. No absolute path
 * and no folder: name, slug, target, status, profile and dates only. Pure:
 * the page downloads the text through a `blob:` link, which the server's
 * CSP leaves alone (no directive governs a download), so nothing is relaxed.
 */

/** U+FEFF, written as a code so the source holds no invisible character. */
const BOM = String.fromCharCode(0xfeff);

export interface ProjectsCsvHeaders {
  name: string;
  slug: string;
  target: string;
  status: string;
  profile: string;
  created: string;
  updated: string;
  archived: string;
}

/**
 * One CSV field: quoted when it holds a comma, a quote or a line break.
 * A field that a spreadsheet would read as a formula (it starts with =, +,
 * -, @, a tab or a carriage return) is given a leading apostrophe.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function projectsCsv(projects: readonly ProjectListing[], headers: ProjectsCsvHeaders): string {
  const columns: (keyof ProjectsCsvHeaders)[] = ['name', 'slug', 'target', 'status', 'profile', 'created', 'updated', 'archived'];
  const row = (project: ProjectListing): string[] => [
    project.name,
    project.slug,
    project.status?.target ?? '',
    project.status?.status ?? '',
    project.status?.profile ?? '',
    project.created ?? project.status?.created ?? '',
    project.status?.updated ?? '',
    project.status?.archived ?? '',
  ];
  const lines = [columns.map((column) => headers[column]), ...projects.map(row)].map((fields) => fields.map(csvField).join(','));
  // CRLF, as RFC 4180 says, and a byte order mark so spreadsheets read UTF-8.
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** The file name: `briefstack-projects-<YYYY-MM-DD>.csv`. */
export function projectsCsvName(now: Date = new Date()): string {
  return `briefstack-projects-${now.toISOString().slice(0, 10)}.csv`;
}

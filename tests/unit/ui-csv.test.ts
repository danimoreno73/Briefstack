import { describe, expect, it } from 'vitest';
import { uiMessages } from '../../src/i18n/ui.js';
import { csvField, projectsCsv, projectsCsvName } from '../../src/ui/csv.js';
import type { ProjectListing } from '../../src/ui/types.js';

// Projects: "Export CSV" (IDEAS §3; phase 9, step 33).

const projects: ProjectListing[] = [
  {
    slug: 'garden',
    file: 'projects/garden.md',
    name: 'Garden, "the" log',
    created: '2026-10-01',
    status: { target: 'claude-code', path: 'C:/Users/someone/briefstack-projects/garden', status: 'created', profile: 'saver', updated: '2026-11-02', archived: '2026-11-03' },
  },
  { slug: 'broken', file: 'projects/broken.md', name: '=HYPERLINK("http://x")', issues: ['no status'] },
];

describe('the projects CSV', () => {
  it('has the columns in the page\'s language, one row per project, no path or folder', () => {
    const text = projectsCsv(projects, uiMessages.en.csvHeaders);
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Name,Slug,Target,Status,Profile,Created,Updated,Archived');
    expect(lines[1]).toBe('"Garden, ""the"" log",garden,claude-code,created,saver,2026-10-01,2026-11-02,2026-11-03');
    expect(lines[2]).toBe(`"'=HYPERLINK(""http://x"")",broken,,,,,,`);
    expect(lines[3]).toBe('');
    expect(text).not.toContain('Users');
    expect(text).not.toContain('projects/garden.md');
    expect(projectsCsv([], uiMessages.es.csvHeaders).slice(1)).toBe('Nombre,Identificador,Destino,Estado,Perfil,Creado,Actualizado,Archivado\r\n');
  });

  it('quotes what needs it and defuses spreadsheet formulas', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    for (const start of ['=', '+', '-', '@']) expect(csvField(`${start}1`)).toBe(`'${start}1`);
  });

  it('names the file by the day', () => {
    expect(projectsCsvName(new Date('2026-11-22T10:00:00Z'))).toBe('briefstack-projects-2026-11-22.csv');
  });
});

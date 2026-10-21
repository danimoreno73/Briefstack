import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { expect, test } from '../e2e/fixtures.js';

// The three type variants of direction A (UI pass, step U1b): for each one a
// specimen sheet, the projects list and the creation screen at the spec
// approval, at 1280 px light and dark and 390 px light. Not part of the test
// suite. `SHOTS_OUT` names the folder, relative to the repo (default
// `screenshots/u1b`, which git ignores). The specimen is served to the
// browser by the test itself, at the app's origin, so the bundled fonts load
// from briefstack's own server.
// Run: `npm run screenshots -- type.shots.ts`.

const OUT = path.join(PACKAGE_ROOT, ...(process.env.SHOTS_OUT ?? 'screenshots/u1b').split('/'));

const VARIANTS = [
  { id: '1', name: 'Source Sans 3 + Source Code Pro', faces: ['Source Sans 3', 'Source Code Pro'] },
  { id: '2', name: 'Bricolage Grotesque + JetBrains Mono', faces: ['Bricolage Grotesque', 'JetBrains Mono'] },
  { id: '3', name: 'Newsreader + Instrument Sans + Inconsolata', faces: ['Newsreader', 'Instrument Sans', 'Inconsolata'] },
] as const;

const VIEWS = [
  { name: '1280-light', width: 1280, height: 900, scheme: 'light' },
  { name: '1280-dark', width: 1280, height: 900, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, scheme: 'light' },
] as const;

const PANEL_USAGE = [
  { fiveHour: 12, sevenDay: 40 },
  { fiveHour: 15, sevenDay: 41 },
];

function specimen(variant: (typeof VARIANTS)[number]): string {
  const figures = ['1 111', '10 480', '7 096', '41 %', '0:42', '12:07:31'];
  const rows = (cls: string) =>
    `<table class="${cls}"><tbody>${figures.map((value, i) => `<tr><td>${['Llamadas', 'Tokens', 'Líneas', 'Semana', 'Duración', 'Hora'][i]}</td><td>${value}</td></tr>`).join('')}</tbody></table>`;
  return `<!doctype html>
<html lang="es" data-direction="a" data-type="${variant.id}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>briefstack type ${variant.id}</title>
<link rel="stylesheet" href="/style.css" />
<link rel="stylesheet" href="/directions.css" />
<link rel="stylesheet" href="/type-variants.css" />
<link rel="stylesheet" href="/__specimen.css" />
</head>
<body>
<main class="specimen">
  <strong class="logo"><span class="logo-brief">brief</span><span class="logo-stack">stack</span></strong>
  <h1>Variante ${variant.id}</h1>
  <p class="idea">${variant.name}</p>

  <section>
    <p class="label">Escala</p>
    <div class="row"><span class="meta">Título · var(--fs-title)</span><span class="s-title">Nuevo proyecto</span></div>
    <div class="row"><span class="meta">Sección</span><span class="s-section">Aprueba la especificación</span></div>
    <div class="row"><span class="meta">Entradilla</span><span class="s-lead">Un planificador de huerto para mi familia, con calendario de siembra.</span></div>
    <div class="row"><span class="meta">Texto</span><span class="s-body">El agente entrevistador ha terminado; falta tu aprobación para seguir.</span></div>
    <div class="row"><span class="meta">Meta</span><span class="s-meta">opus · high · 10:48:09 · 0 s</span></div>
    <div class="row"><span class="meta">Etiqueta</span><span class="s-label">Agentes</span></div>
  </section>

  <section>
    <p class="label">Pesos</p>
    <div class="weights">
      <span class="w-400">Regular 400</span><span class="w-500">Medio 500</span><span class="w-600">Fuerte 600</span><span class="w-700">Grueso 700</span>
    </div>
    <div class="weights display">
      <span class="w-400">Título 400</span><span class="w-600">Título 600</span><span class="w-700">Título 700</span>
    </div>
  </section>

  <section>
    <p class="label">Mono: rutas, ids, agentes, comandos</p>
    <div class="row"><span class="meta">Ruta</span><span class="mono">&lt;home&gt;/briefstack-projects/garden-planner/CLAUDE.md</span></div>
    <div class="row"><span class="meta">Id de sesión</span><span class="mono">sess-2026-10-21-7f3a9c</span></div>
    <div class="row"><span class="meta">Agentes</span><span class="mono">interviewer · architect · generator · reviewer</span></div>
    <div class="row"><span class="meta">Comando</span><span class="mono">npm run briefstack -- usage set balanced</span></div>
    <div class="row"><span class="meta">Mezcla</span><span>El <span class="mono">architect</span> escribió <span class="mono">spec.md</span> en 0:42.</span></div>
  </section>

  <section>
    <p class="label">Cifras</p>
    <div class="figures">
      <div><p class="meta">Proporcionales</p>${rows('proportional')}</div>
      <div><p class="meta">Tabulares</p>${rows('tabular')}</div>
    </div>
  </section>

  <section class="prose">
    <h2>Texto de ejemplo</h2>
    <p>¿Qué quieres crear? Describe la idea con tus palabras: quién lo usará, qué problema resuelve y qué debería pasar al terminar. briefstack hará unas pocas preguntas, escribirá una especificación y, cuando la apruebes, generará la carpeta del proyecto lista para abrir con Claude.</p>
    <p class="muted">Nada sale de este equipo: el servidor escucha solo en 127.0.0.1 y cada pestaña lleva su propio token. Año 2026, señal, pingüino, ¡listo!</p>
  </section>
</main>
</body>
</html>`;
}

/** The test's temp folder, shown as `<tmp>` so no path from this machine lands in a picture. */
async function hideTempDir(page: Page, tempDir: string): Promise<void> {
  const variants = [tempDir, tempDir.replaceAll('\\', '/')];
  await page.evaluate((prefixes) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue !== null && prefixes.some((prefix) => node.nodeValue?.includes(prefix))) {
        node.nodeValue = prefixes.reduce((out, prefix) => out.split(prefix).join('<tmp>'), node.nodeValue);
      }
    }
  }, variants);
}

/** Fails when a face did not load, or when tabular figures do not change the digits' widths. */
async function checkFaces(page: Page, faces: readonly string[]): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate((names) => {
    const loaded = names.map((name) => [name, document.fonts.check(`16px "${name}"`) && [...document.fonts].some((face) => face.family.replaceAll('"', '') === name && face.status === 'loaded')] as const);
    const width = (text: string, numeric: string, family: string) => {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.fontFamily = `"${family}"`;
      span.style.fontVariantNumeric = numeric;
      span.style.fontSize = '40px';
      span.style.position = 'absolute';
      document.body.append(span);
      const value = span.getBoundingClientRect().width;
      span.remove();
      return value;
    };
    const tabular = names.map((name) => [name, Math.abs(width('111111', 'tabular-nums', name) - width('000000', 'tabular-nums', name)) < 0.5] as const);
    return { loaded, tabular };
  }, faces);
  for (const [name, ok] of result.loaded) expect(ok, `${name} loaded`).toBe(true);
  for (const [name, ok] of result.tabular) expect(ok, `${name} has tabular figures`).toBe(true);
}

for (const variant of VARIANTS) {
  for (const view of VIEWS) {
    const folder = path.join(OUT, `v${variant.id}`, view.name);
    let tempDir = '';
    const shot = async (page: Page, name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await hideTempDir(page, tempDir);
      await page.screenshot({ path: path.join(folder, `${name}.jpg`), fullPage: true, type: 'jpeg', quality: 82 });
    };

    test.describe(`variant ${variant.id}, ${view.name}`, () => {
      test.use({ viewport: { width: view.width, height: view.height }, colorScheme: view.scheme });
      test.beforeEach(async ({ page, app }) => {
        tempDir = app.dir;
        await page.addInitScript((id) => {
          localStorage.setItem('briefstack-direction', 'a');
          localStorage.setItem('briefstack-type', id);
        }, variant.id);
      });

      test('specimen and projects', async ({ page, app }) => {
        const origin = new URL(app.url).origin;
        const css = await readFile(path.join(PACKAGE_ROOT, 'tests', 'screenshots', 'specimen.css'), 'utf8');
        await page.route(`${origin}/__specimen`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: specimen(variant) }));
        await page.route(`${origin}/__specimen.css`, (route) => route.fulfill({ contentType: 'text/css; charset=utf-8', body: css }));
        await page.goto(`${origin}/__specimen`);
        await checkFaces(page, variant.faces);
        await shot(page, '00-specimen');

        await page.goto(app.url);
        await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
        await expect(page.getByTestId('unfinished')).toBeVisible();
        await shot(page, '01-projects');
      });

      test.describe('the creation at the spec', () => {
        test.use({ appOptions: { recording: 'panel.jsonl', planUsage: PANEL_USAGE } });
        test('creation', async ({ page, app }) => {
          await page.goto(app.url);
          await page.getByRole('link', { name: 'New project' }).click();
          await page.getByLabel('Describe your idea').fill('A garden planner for my family, with a planting calendar.');
          await page.getByRole('button', { name: 'Start' }).click();
          await expect(page.getByTestId('node-pending')).toBeVisible();
          await page.getByRole('button', { name: 'Send answers' }).click();
          await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
          await shot(page, '06-creation-spec');
        });
      });
    });
  }
}

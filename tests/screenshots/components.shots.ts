import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { expect, test } from '../e2e/fixtures.js';

// The shared components in their states (UI pass, U2), plus the projects list
// and the creation at the spec approval, at 1280 px light and dark and 390 px
// light. Not part of the test suite. The components page
// (tests/screenshots/components.html) is served by the test itself at the
// app's origin, so it uses briefstack's own tokens, styles and fonts.
// `SHOTS_OUT` names the folder, relative to the repo (default
// `screenshots/u2`, which git ignores).
// Run: `npm run screenshots -- components.shots.ts`.

const OUT = path.join(PACKAGE_ROOT, ...(process.env.SHOTS_OUT ?? 'screenshots/u2').split('/'));
const HERE = path.join(PACKAGE_ROOT, 'tests', 'screenshots');

const VIEWS = [
  { name: '1280-light', width: 1280, height: 900, theme: 'light' },
  { name: '1280-dark', width: 1280, height: 900, theme: 'dark' },
  { name: '390-light', width: 390, height: 844, theme: 'light' },
] as const;

const PANEL_USAGE = [
  { fiveHour: 12, sevenDay: 40 },
  { fiveHour: 15, sevenDay: 41 },
];

for (const view of VIEWS) {
  const folder = path.join(OUT, view.name);
  let tempDir = '';
  const shot = async (page: Page, name: string, fullPage = true) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    // The test's temp folder is shown as `<tmp>`.
    await page.evaluate((prefixes) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.nodeValue !== null && prefixes.some((prefix) => node.nodeValue?.includes(prefix))) {
          node.nodeValue = prefixes.reduce((out, prefix) => out.split(prefix).join('<tmp>'), node.nodeValue);
        }
      }
    }, [tempDir, tempDir.replaceAll('\\', '/')]);
    await page.screenshot({ path: path.join(folder, `${name}.jpg`), fullPage, type: 'jpeg', quality: 82 });
  };

  test.describe(view.name, () => {
    // The theme is set through the app's own switch value, so the shots also cover it.
    test.use({ viewport: { width: view.width, height: view.height }, colorScheme: 'light' });
    test.beforeEach(async ({ page, app }) => {
      tempDir = app.dir;
      await page.addInitScript((theme) => localStorage.setItem('briefstack-theme', theme), view.theme);
    });

    test('components', async ({ page, app }) => {
      const origin = new URL(app.url).origin;
      const html = await readFile(path.join(HERE, 'components.html'), 'utf8');
      const css = await readFile(path.join(HERE, 'components.css'), 'utf8');
      await page.route(`${origin}/__components`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      await page.route(`${origin}/__components.css`, (route) => route.fulfill({ contentType: 'text/css; charset=utf-8', body: css }));
      await page.goto(`${origin}/__components`);
      if (view.theme === 'dark') await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      await page.locator('#focused').focus();
      await shot(page, '00-components');
      await page.evaluate(() => (document.getElementById('dialog') as HTMLDialogElement).showModal());
      await shot(page, '00-components-dialog', false);
    });

    test('projects', async ({ page, app }) => {
      await page.goto(app.url);
      await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', view.theme);
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

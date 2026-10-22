import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { SESSION_INTERRUPTED, clickNav, expect, test } from '../e2e/fixtures.js';

// The creation screen and a finished session's panel, at desktop and phone
// width, in both themes (U5). Output: `screenshots/u5/`, git-ignored.
const OUT = path.join(PACKAGE_ROOT, 'screenshots', 'u5');
const VIEWS = [
  { name: 'desktop-dark', width: 1280, height: 900, scheme: 'dark' },
  { name: 'desktop-light', width: 1280, height: 900, scheme: 'light' },
  { name: 'narrow-dark', width: 390, height: 844, scheme: 'dark' },
  { name: 'narrow-light', width: 390, height: 844, scheme: 'light' },
] as const;

// A full-page picture stitches the page: what stays in place while scrolling (the creation's head, the
// rail, the phone's top bar) would land in the middle. For the picture only, they scroll with the page.
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true, style: '.sticky, .rail, .topbar { position: static !important; } .rail { height: auto !important; align-self: stretch !important; }' });
};

for (const size of VIEWS) {
  test.describe(`panel at ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      colorScheme: size.scheme,
      appOptions: { recording: 'panel.jsonl', planUsage: [{ fiveHour: 12, sevenDay: 40 }, { fiveHour: 15, sevenDay: 41 }] },
    });

    test('live creation, the spec, the permission, the result', async ({ page, app }) => {
      await page.goto(app.url);
      await clickNav(page, 'New project');
      await page.getByLabel('Describe your idea').fill('A garden planner for my family, with a planting calendar.');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      await expect(page.getByTestId('node-pending')).toBeVisible();
      await shot(page, `${size.name}-1-question`);
      await page.getByRole('button', { name: 'Send answers' }).click();
      await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
      await page.getByTestId('agent-a1').getByRole('button', { name: /architect/ }).click();
      await shot(page, `${size.name}-2-spec-denial`);
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByTestId('agent-g1').getByTestId('node-pending')).toBeVisible();
      await shot(page, `${size.name}-3-permission`);
      await page.getByRole('group', { name: 'Agents view' }).getByRole('button', { name: 'Text' }).click();
      await shot(page, `${size.name}-3b-text-view`);
      await page.getByRole('button', { name: 'Allow' }).click();
      await expect(page.getByTestId('result')).toBeVisible();
      await expect(page.getByTestId('agent-main').getByTestId('node-status')).toHaveText('Done');
      await shot(page, `${size.name}-4-result`);
    });

    test('a finished session from the real H10 run and an interrupted one', async ({ page, app }) => {
      const { cp } = await import('node:fs/promises');
      await cp(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'sessions', 'h10-run3.jsonl'), path.join(app.sessionsDir, 'h10-run3-session', 'events.jsonl'));
      await page.goto(app.url);
      await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
      await page.evaluate(() => (window.location.hash = '#/sessions/h10-run3-session'));
      await expect(page.getByTestId('session-status')).toContainText('Completed');
      await shot(page, `${size.name}-5-h10-run3`);
      await page.evaluate((id) => (window.location.hash = `#/sessions/${id}`), SESSION_INTERRUPTED);
      await expect(page.getByTestId('session-status')).toContainText('Interrupted');
      await shot(page, `${size.name}-6-interrupted`);
    });
  });
}

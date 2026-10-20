import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { SESSION_INTERRUPTED, expect, test } from '../e2e/fixtures.js';

const OUT = path.join(PACKAGE_ROOT, 'screenshots');
const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
] as const;

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

for (const size of WIDTHS) {
  test.describe(`panel at ${size.name} width`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      appOptions: { recording: 'panel.jsonl', planUsage: [{ fiveHour: 12, sevenDay: 40 }, { fiveHour: 15, sevenDay: 41 }] },
    });

    test('live creation, the spec, the permission, the result', async ({ page, app }) => {
      await page.goto(app.url);
      await page.getByRole('link', { name: 'New project' }).click();
      await page.getByLabel('Describe your idea').fill('A garden planner for my family, with a planting calendar.');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      await expect(page.getByTestId('node-pending')).toBeVisible();
      await shot(page, `${size.name}-1-question`);
      await page.getByRole('button', { name: 'Send answers' }).click();
      await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
      await page.getByTestId('agent-a1').getByRole('button', { name: /architect/ }).click();
      await page.locator('details.panel-text summary').click();
      await shot(page, `${size.name}-2-spec-denial`);
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByTestId('agent-g1').getByTestId('node-pending')).toBeVisible();
      await shot(page, `${size.name}-3-permission`);
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

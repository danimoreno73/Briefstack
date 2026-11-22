import { readFile } from 'node:fs/promises';
import { codeProject, expect, test } from './fixtures.js';

// Projects: "Export CSV" (IDEAS §3; phase 9, step 33): built in the page, downloaded through a blob: link under the
// server's own CSP (nothing relaxed), with no absolute path in it.

test('the projects list downloads as CSV, under the CSP, with no path', async ({ page, app }) => {
  const dir = await codeProject(app, 'garden', 'Garden');
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate(() => (window.location.hash = '#/projects'));
  await expect(page.getByTestId('projects')).toContainText('Garden');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(download.suggestedFilename()).toMatch(/^briefstack-projects-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = await download.path();
  const text = await readFile(file, 'utf8');
  // The file starts with a byte order mark (code 0xFEFF), for spreadsheets.
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text.slice(1).split('\r\n')[0]).toBe('Name,Slug,Target,Status,Profile,Created,Updated,Archived');
  // The name is the note's title, as the table shows it.
  expect(text).toMatch(/\r\nGarden[^,\r\n]*,garden,claude-code,created,/);
  // The project's folder is not in it, with either slash.
  expect(text).not.toContain(dir);
  expect(text).not.toContain(dir.replaceAll('\\', '/'));
  expect(violations).toEqual([]);
});

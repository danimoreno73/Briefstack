import type { Page } from '@playwright/test';
import type { PlanOutput, QueueItem } from '../../src/builds/types.js';
import type { TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { codeProject, expect, test, type App } from './fixtures.js';

// Phase 12, M3: the build's pages on a phone (390×844), over the fake
// planner and task runner: the board before the start, and the build page
// with its progress table as cards, without sideways scroll. The sign-in
// page at phone width is in its own test below.

const SLOW = { timeout: 30_000 };
test.describe.configure({ timeout: 90_000 });

const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- Cards.\n';
const writes: TaskFakeScript = (_round, prompt) => ({
  steps: [{ kind: 'write', file: prompt.includes('Write NOTES.md') ? 'NOTES.md' : 'SUMMARY.md', content: 'text\n' }, { kind: 'end', summary: 'Done.' }],
});
const card = (title: string, instruction: string, area: string[], dependsOn: number[] = []): QueueItem => ({ title, instruction, doneWhen: 'Done.', dependsOn, area, size: 'S' });
const PLAN: PlanOutput = {
  tasks: [
    card('Notes with a long title that has to wrap on a narrow screen', 'Write NOTES.md.', ['NOTES.md', 'notes/a-very-long-folder-name-that-must-wrap/']),
    card('Summary', 'Write SUMMARY.md.', ['SUMMARY.md'], [1]),
  ],
  commands: ['npm test'],
  checks: [],
};

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Every element of the progress table that sticks out of the viewport on the right. */
const progressOverflow = (page: Page) =>
  page.evaluate(() => {
    const table = document.querySelector('[data-testid="build-progress"] table');
    if (table === null) return -1;
    const right = document.documentElement.clientWidth;
    return [...table.querySelectorAll('td')].filter((cell) => {
      const box = cell.getBoundingClientRect();
      return box.width > 0 && box.right > right + 1;
    }).length;
  });

async function goTo(page: Page, app: App, hash: string): Promise<void> {
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate((target) => (window.location.hash = target), hash);
}

test.describe('a build on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, appOptions: { taskScript: writes, buildPlan: PLAN } });

  test('the board before the start and the build page never scroll sideways, and the progress shows every column', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await goTo(page, app, '#/projects/garden');
    await page.getByTestId('build-implement').click();
    await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
    await expect.poll(() => sideways(page)).toBeLessThanOrEqual(0);

    await page.getByTestId('build-no-checks-confirm').check();
    await page.getByTestId('build-start').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-progress')).toBeVisible();
    await expect.poll(() => sideways(page)).toBeLessThanOrEqual(0);
    await expect.poll(() => progressOverflow(page)).toBe(0);
    // Each row is a card: its cells say which column they are, "Checks" included (cut off before; H0, 4).
    const row = page.getByTestId('build-task-row').first();
    await expect(row.getByTestId('build-task-checks')).toBeVisible();
    await expect(row.getByTestId('build-task-checks')).toHaveAttribute('data-label', 'Checks');
    await expect(row.getByTestId('build-task-tokens')).toBeInViewport();
  });
});

test.describe('server mode on a phone', () => {
  const secret = ['phone', 'p'.repeat(40)].join('-');
  test.use({ viewport: { width: 390, height: 844 }, appOptions: { serverSecret: secret } });

  test('the sign-in page and the devices card fit the screen', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await expect.poll(() => sideways(page)).toBeLessThanOrEqual(0);
    await page.getByLabel('Access secret').fill(secret);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('nav#rail').waitFor({ state: 'attached' });
    await page.evaluate(() => (window.location.hash = '#/settings'));
    await expect(page.getByTestId('device')).toHaveCount(1);
    await expect(page.getByTestId('device-revoke')).toBeInViewport();
    await expect.poll(() => sideways(page)).toBeLessThanOrEqual(0);
  });
});

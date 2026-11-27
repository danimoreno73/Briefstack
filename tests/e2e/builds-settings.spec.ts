import { clickNav, codeProject, expect, test } from './fixtures.js';

// Phase 12, M5: the builds' settings of a machine that stays on: auto-resume
// and the cap on slots, saved from Settings; the start page offers no more
// slots than the cap and says so.

const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- Notes.\n- A summary.\n';

test('Settings saves auto-resume and the cap on slots, and the start page offers no more than the cap', async ({ page, app }) => {
  await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
  await page.goto(app.url);
  await clickNav(page, 'Settings');
  const card = page.getByTestId('settings-builds');
  await expect(card.getByTestId('settings-builds-resume')).not.toBeChecked();
  await expect(card.getByTestId('settings-builds-slots')).toHaveValue('4');
  await card.getByTestId('settings-builds-resume').check();
  await card.getByTestId('settings-builds-slots').fill('1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('settings-builds-resume')).toBeChecked();
  await expect(page.getByTestId('settings-builds-slots')).toHaveValue('1');

  await page.evaluate(() => (window.location.hash = '#/projects/garden'));
  await page.getByTestId('build-implement').click();
  await expect(page.getByTestId('build-start-form')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('build-slots')).toHaveValue('1');
  await expect(page.getByTestId('build-slots')).toHaveAttribute('max', '1');
  await expect(page.getByTestId('build-slots-cap')).toHaveText('This machine runs at most 1 card at once (Settings).');
});

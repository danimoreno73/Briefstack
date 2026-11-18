import type { Page } from '@playwright/test';
import type { TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { testGit } from '../improveWorld.js';
import { codeProject, expect, test, type App } from './fixtures.js';

// Builds (BRIEF-phase-9 §5) over the fake planner and the fake task runner,
// with the real wiring (integration branch, checks after each round, rules).

/** Each task writes a file named after its title, so every task changes something. */
const byTitle: TaskFakeScript = (_round, prompt) => {
  const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'Task';
  return { steps: [{ kind: 'write', file: `${title.toUpperCase()}.md`, content: `${title}.\n` }, { kind: 'end', summary: `Wrote ${title}.` }] };
};

const SLOW = { timeout: 30_000 };
const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- Notes.\n- A summary.\n';

async function goTo(page: Page, app: App, hash: string): Promise<void> {
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate((target) => (window.location.hash = target), hash);
}

/** Opens the project page and presses "Implement"; waits for the start page. */
async function plan(page: Page, app: App): Promise<void> {
  await goTo(page, app, '#/projects/garden');
  await page.getByTestId('build-implement').click();
  await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
}

test.describe('builds', () => {
  test.use({ appOptions: { taskScript: byTitle } });

  test('plan, edit and start a build: the first task is applied to the build\'s branch, the project\'s branch untouched', async ({ page, app }) => {
    const dir = await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    const before = (await testGit(dir, ['rev-parse', 'HEAD'])).trim();
    await plan(page, app);
    await expect(page.getByTestId('build-state')).toHaveText('Ready to start');
    await expect(page.getByTestId('build-queue-item')).toHaveCount(2);
    await expect(page.getByTestId('build-warning')).toContainText('A build runs code before you read it');
    await expect(page.getByTestId('build-no-codex')).toContainText('A build never hands work to Codex');
    // Edit: a clearer title for the first task, one command more, then remove the second task.
    await page.getByTestId('build-item-title').first().fill('Notes');
    await page.getByTestId('build-commands').fill('npm test\nnpm run lint');
    await page.getByTestId('build-item-remove').nth(1).click();
    await expect(page.getByTestId('build-queue-item')).toHaveCount(1);
    await page.getByTestId('build-limit').fill('1');
    await page.getByTestId('build-start').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('confirm-items')).toContainText('npm run lint');
    await dialog.getByRole('button', { name: 'Start the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-task-row')).toHaveCount(1);
    await expect(page.getByTestId('build-task-state')).toHaveText('Applied');

    const id = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/builds\//, ''));
    const build = await app.builds.get(id);
    expect(build.settings?.commands).toEqual(['npm test', 'npm run lint']);
    expect((await testGit(dir, ['show', `${build.branch}:NOTES.md`])).trim()).toBe('Notes.');
    expect((await testGit(dir, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    expect(await testGit(dir, ['status', '--porcelain'])).toBe('');
  });

  test('a start with a command the list cannot hold is refused, with nothing started', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await page.getByTestId('build-commands').fill('npm test && rm -rf .');
    await page.getByTestId('build-start').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
    await expect(page.getByRole('alert').or(page.locator('.note-danger')).filter({ hasText: 'cannot start with these settings' })).toBeVisible();
    await expect(page.getByTestId('build-state')).toHaveText('Ready to start');
  });

  test('a planned build can be discarded, and the project offers Implement again', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await page.getByTestId('build-discard').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Discarded');
    await expect(page.getByTestId('build-discarded')).toBeVisible();
    await expect(page.getByTestId('build-start-form')).toHaveCount(0);
    await goTo(page, app, '#/projects/garden');
    await expect(page.getByTestId('build-implement')).toBeVisible();
  });

  test('a project without a brief cannot be planned; the page says why', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden');
    await goTo(page, app, '#/projects/garden');
    await expect(page.getByTestId('build-cannot-plan')).toContainText('no docs/BRIEF.md');
    await expect(page.getByTestId('build-implement')).toHaveCount(0);
  });
});

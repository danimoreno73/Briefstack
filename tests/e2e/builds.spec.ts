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

  test('the whole change shows on the build\'s page; apply lands it in the project as one commit, and revert undoes it', async ({ page, app }) => {
    const dir = await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    const before = (await testGit(dir, ['rev-parse', 'HEAD'])).trim();
    await plan(page, app);
    await page.getByTestId('build-start').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-task-state')).toHaveText(['Applied', 'Applied']);
    await expect(page.getByTestId('build-diff')).toContainText('NOTES.md');
    await expect(page.getByTestId('build-diff')).toContainText('SUMMARY.md');
    await page.getByTestId('build-apply').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Applied', SLOW);
    await expect(page.getByTestId('build-applied')).toBeVisible();
    expect((await testGit(dir, ['rev-parse', 'HEAD^'])).trim()).toBe(before);
    expect((await testGit(dir, ['show', 'HEAD:NOTES.md'])).trim()).toBe('Notes.');
    await page.getByTestId('build-revert').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revert' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Reverted', SLOW);
    await expect(page.getByTestId('build-reverted')).toBeVisible();
    expect(await testGit(dir, ['ls-files', 'NOTES.md'])).toBe('');
  });

  test('a discard removes the build\'s branch; nothing reaches the project', async ({ page, app }) => {
    const dir = await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    const before = (await testGit(dir, ['rev-parse', 'HEAD'])).trim();
    await plan(page, app);
    await page.getByTestId('build-start').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    const id = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/builds\//, ''));
    const branch = (await app.builds.get(id)).branch;
    await page.getByTestId('build-discard').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Discarded', SLOW);
    expect(await testGit(dir, ['branch', '--list', branch])).toBe('');
    expect((await testGit(dir, ['rev-parse', 'HEAD'])).trim()).toBe(before);
  });

  test('a project without a brief cannot be planned; the page says why', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden');
    await goTo(page, app, '#/projects/garden');
    await expect(page.getByTestId('build-cannot-plan')).toContainText('no docs/BRIEF.md');
    await expect(page.getByTestId('build-implement')).toHaveCount(0);
  });
});

/** Starts the planned build with what the planner proposed, changing the checks and fix rounds when given. */
async function startBuild(page: Page, settings: { checks?: string; fixRounds?: string } = {}): Promise<void> {
  if (settings.checks !== undefined) await page.getByTestId('build-checks').fill(settings.checks);
  if (settings.fixRounds !== undefined) await page.getByTestId('build-fix-rounds').fill(settings.fixRounds);
  await page.getByTestId('build-start').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
}

test.describe('builds: a pause for usage', () => {
  // Over the 5-hour threshold with no reset time: the build pauses until the user resumes it (or 15 minutes pass).
  test.use({ appOptions: { taskScript: byTitle, buildUsage: [{ kind: 'ok', fiveHour: 95, sevenDay: 10 }] } });

  test('the page says why and until when; Resume goes on without reading the usage', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await startBuild(page);
    await expect(page.getByTestId('build-state')).toHaveText('Paused', SLOW);
    await expect(page.getByTestId('build-paused')).toContainText('the plan usage is at or above its threshold');
    await expect(page.getByTestId('build-task-state')).toHaveText(['Queued', 'Queued']);
    await page.getByTestId('build-resume').click();
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-task-state')).toHaveText(['Applied', 'Applied']);
  });
});

test.describe('builds: a failed check', () => {
  // "Notes" leaves BROKEN, which the project's check refuses; "Summary" depends on it.
  const breaking: TaskFakeScript = (round, prompt) => {
    const base = byTitle(round, prompt) ?? { steps: [] };
    return /The task: Notes/.test(prompt) ? { steps: [{ kind: 'write', file: 'BROKEN', content: 'x\n' }, ...base.steps] } : base;
  };
  test.use({ appOptions: { taskScript: breaking } });

  test('leaves the task waiting with a link to its page, and its dependent skipped', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF, 'check.cjs': "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0);\n" });
    await plan(page, app);
    await startBuild(page, { checks: 'node check.cjs', fixRounds: '0' });
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-task-state')).toHaveText(['Waiting for you', 'Skipped']);
    await expect(page.getByTestId('build-task-reason')).toHaveText('its checks failed');
    await expect(page.getByTestId('build-task-checks').first()).toHaveText('0 of 1 passed');
    await expect(page.getByTestId('build-open-task')).toBeVisible();
    // Apply waits for the user's decision on the waiting task.
    await page.getByTestId('build-apply').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply the build' }).click();
    await expect(page.locator('.note-danger').or(page.getByRole('alert')).filter({ hasText: 'wait for you' })).toBeVisible();
    await page.getByTestId('build-open-task').click();
    await expect(page.getByTestId('task-diff')).toContainText('BROKEN', SLOW);
  });
});

test.describe('builds: cancel', () => {
  const slow: TaskFakeScript = () => ({ steps: [{ kind: 'wait', ms: 60_000 }, { kind: 'end', summary: 'Done.' }] });
  test.use({ appOptions: { taskScript: slow } });

  test('stops the task at work at once; the build and the task are cancelled', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await startBuild(page);
    await expect(page.getByTestId('build-task-state').first()).toHaveText('Running', SLOW);
    await page.getByTestId('build-cancel').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Cancelled', SLOW);
    await expect(page.getByTestId('build-task-state')).toHaveText(['Cancelled', 'Queued']);
    await expect(page.getByTestId('build-cancelled')).toBeVisible();
  });
});

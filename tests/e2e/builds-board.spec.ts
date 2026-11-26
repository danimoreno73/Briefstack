import type { Page } from '@playwright/test';
import type { PlanOutput, QueueItem } from '../../src/builds/types.js';
import type { TaskFakeScript, TaskFakeStep } from '../../src/tasks/fakeRunner.js';
import { testGit } from '../improveWorld.js';
import { codeProject, expect, test, type App } from './fixtures.js';

// The build's board and cards run in parallel (BRIEF-phase-11 §5) over the
// fake planner and the fake task runner, with the real wiring: worktrees, the
// join onto the integration branch, the redo and the final apply.

const SLOW = { timeout: 30_000 };

// Cards that wait seconds on purpose, then a redo or an apply: more than the default 30 s per test on a shared machine.
test.describe.configure({ timeout: 90_000 });
const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- Cards.\n';

/**
 * A round reads its card's instruction: `WAIT <ms>` and `WRITE <file>: <text>`
 * lines; in its redo (the prompt says so), `REDO-WAIT` and `REDO-WRITE` lines
 * when it has them.
 */
const byInstruction: TaskFakeScript = (_round, prompt) => {
  const redo = prompt.includes('being done a second time');
  const lines = (tag: string) => [...prompt.matchAll(new RegExp(`^${tag} (.+)$`, 'gm'))].map((match) => match[1] as string);
  const waitTag = redo && lines('REDO-WAIT').length > 0 ? 'REDO-WAIT' : 'WAIT';
  const writeTag = redo && lines('REDO-WRITE').length > 0 ? 'REDO-WRITE' : 'WRITE';
  const steps: TaskFakeStep[] = [
    ...lines(waitTag).map((ms): TaskFakeStep => ({ kind: 'wait', ms: Number(ms) })),
    ...lines(writeTag).map((line): TaskFakeStep => {
      const [file, ...text] = line.split(': ');
      return { kind: 'write', file: file as string, content: `${text.join(': ')}\n` };
    }),
    { kind: 'end', summary: 'Done.' },
  ];
  return { steps };
};

const card = (title: string, instruction: string, area: string[], dependsOn: number[] = []): QueueItem => ({ title, instruction, doneWhen: 'Done.', dependsOn, area, size: 'S' });
const board = (tasks: QueueItem[]): PlanOutput => ({ tasks, commands: ['npm test'], checks: [] });

async function goTo(page: Page, app: App, hash: string): Promise<void> {
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate((target) => (window.location.hash = target), hash);
}

/** Plans the build from the project page and waits for the board to edit; confirms a start without checks. */
async function plan(page: Page, app: App): Promise<void> {
  await goTo(page, app, '#/projects/garden');
  await page.getByTestId('build-implement').click();
  await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
  await page.getByTestId('build-no-checks-confirm').check();
}

async function start(page: Page): Promise<void> {
  await page.getByTestId('build-start').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
}

const buildId = (page: Page): string => decodeURIComponent(new URL(page.url()).hash.replace(/^#\/builds\//, ''));

test.describe('the board before the start', () => {
  test.use({ appOptions: { taskScript: byInstruction, buildPlan: board([card('Notes', 'WRITE NOTES.md: notes', ['NOTES.md']), card('Summary', 'WRITE SUMMARY.md: summary', ['SUMMARY.md'], [1])]) } });

  test('edit a card, add one by hand, keep dependencies in order, set the slots, and start it', async ({ page, app }) => {
    const dir = await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await expect(page.getByTestId('build-item-area').first()).toHaveValue('NOTES.md');
    await expect(page.getByTestId('build-item-area').nth(1)).toHaveValue('SUMMARY.md');
    await expect(page.getByTestId('build-slots')).toHaveValue('2');
    await expect(page.getByTestId('build-slots-note')).toContainText('spend the plan’s 5-hour window faster');
    // Summary depends on Notes: it cannot go above it.
    await expect(page.getByTestId('build-item-up').nth(1)).toBeDisabled();
    await expect(page.getByTestId('build-item-down').first()).toBeDisabled();
    await page.getByTestId('build-item-size').first().selectOption('L');
    await page.getByTestId('build-item-add').click();
    await expect(page.getByTestId('build-queue-item')).toHaveCount(3);
    await page.getByTestId('build-item-title').nth(2).fill('Extra');
    await page.getByTestId('build-item-instruction').nth(2).fill('WRITE EXTRA.md: extra');
    await page.getByTestId('build-item-done').nth(2).fill('EXTRA.md exists.');
    // One path per line; a comma stays inside its path (review of M4).
    await page.getByTestId('build-item-area').nth(2).fill('EXTRA.md\nnotes/a, b.md');
    await expect(page.getByTestId('build-limit')).toHaveValue('3');
    // Extra depends on nothing: it can go above Summary.
    await page.getByTestId('build-item-up').nth(2).click();
    await expect(page.getByTestId('build-item-title').nth(1)).toHaveValue('Extra');
    await start(page);
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-column-done').getByTestId('build-card')).toHaveCount(3);
    const build = await app.builds.get(buildId(page));
    expect(build.settings?.slots).toBe(2);
    expect(build.tasks.map((task) => [task.title, task.size, task.area, task.dependsOn])).toEqual([
      ['Notes', 'L', ['NOTES.md'], []],
      ['Extra', 'M', ['EXTRA.md', 'notes/a, b.md'], []],
      ['Summary', 'S', ['SUMMARY.md'], [1]],
    ]);
    expect((await testGit(dir, ['show', `${build.branch}:EXTRA.md`])).trim()).toBe('extra');
  });

  test('with one card at a time from the page, the build records one slot and runs as before (review of M4, I3)', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await page.getByTestId('build-slots').fill('1');
    await start(page);
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-board')).toContainText('One card at a time.');
    await expect(page.getByTestId('build-task-state')).toHaveText(['Applied', 'Applied']);
    const build = await app.builds.get(buildId(page));
    expect(build.settings?.slots).toBe(1);
    // Phase 9's cap: 2 cards × (1 + 1 fix round), not doubled.
    expect(build.settings?.maxRounds).toBe(4);
  });

  test('a bad area is refused at the start with what is wrong with it', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await page.getByTestId('build-item-area').first().fill('../outside');
    await start(page);
    await expect(page.getByText('task 1: its area has a path that goes up with ..')).toBeVisible();
    await expect(page.getByTestId('build-state')).toHaveText('Ready to start');
  });
});

test.describe('cards at once', () => {
  test.use({ appOptions: { taskScript: byInstruction, buildPlan: board([card('Alpha', 'WAIT 2500\nWRITE A.md: a', ['a/']), card('Beta', 'WAIT 2500\nWRITE B.md: b', ['b/'])]) } });

  test('two cards of separate areas run at the same time, in the Running column together', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await start(page);
    await expect(page.getByTestId('build-column-running').getByTestId('build-card')).toHaveCount(2, SLOW);
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-column-done').getByTestId('build-card')).toHaveCount(2);
    // One joined where it started, the other onto the first's change.
    await expect(page.getByTestId('build-card-join').filter({ hasText: /^Joined\.$/ })).toHaveCount(1);
    // No checks in this build: the page does not claim they ran on the joined tree (review of M4, I1).
    await expect(page.getByTestId('build-card-join').filter({ hasText: 'Joined onto other cards’ changes (the build has no checks to run).' })).toHaveCount(1);
    await expect(page.getByText('checked again there')).toHaveCount(0);
  });
});

test.describe('a conflict redone and joined, then applied', () => {
  test.use({ appOptions: { taskScript: byInstruction, buildPlan: board([card('One', 'WRITE A.md: one', ['one/']), card('Two', 'WAIT 2000\nWRITE A.md: two\nREDO-WRITE A.md: one and two', ['two/'])]) } });

  test('the colliding card is redone on top of the first and joined; apply lands the whole build', async ({ page, app }) => {
    const dir = await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    const before = (await testGit(dir, ['rev-parse', 'HEAD'])).trim();
    await plan(page, app);
    await start(page);
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-column-done').getByTestId('build-card')).toHaveCount(2);
    await expect(page.getByTestId('build-card-redo')).toHaveText('Redone once: it collided with another card when joined.');
    // The diff after the redo's join (an earlier one also names A.md; Apply sends the head the page shows).
    await expect(page.getByTestId('build-diff')).toContainText('one and two', SLOW);
    await page.getByTestId('build-apply').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Applied', SLOW);
    expect((await testGit(dir, ['rev-parse', 'HEAD^'])).trim()).toBe(before);
    expect((await testGit(dir, ['show', 'HEAD:A.md'])).trim()).toBe('one and two');
  });
});

test.describe('a second conflict', () => {
  // Two collides with One and is redone slowly; Three starts after One, joins first, and Two's redo collides again.
  test.use({
    appOptions: {
      taskScript: byInstruction,
      buildPlan: board([
        card('One', 'WRITE A.md: one', ['one/']),
        // Margins of 1.5 s and more: the e2e workers share the machine.
        card('Two', 'WAIT 1500\nWRITE A.md: two\nREDO-WAIT 8000\nREDO-WRITE A.md: two again', ['two/']),
        card('Three', 'WAIT 4000\nWRITE A.md: three', ['three/']),
      ]),
    },
  });

  test('leaves the card waiting for the user, with the file it collided in and a link to its task', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await start(page);
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    const waiting = page.getByTestId('build-column-waiting').getByTestId('build-card');
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText('Two');
    await expect(waiting).toContainText('it collided with other cards when joined, and was not redone again');
    await expect(waiting.getByTestId('build-card-join')).toContainText('A.md');
    await expect(page.getByTestId('build-column-done').getByTestId('build-card')).toHaveCount(2);
    await waiting.getByRole('link', { name: 'Open the task' }).click();
    await expect(page.getByTestId('task-diff')).toContainText('A.md', SLOW);
  });
});

test.describe('a skipped card', () => {
  // "Broken" leaves BROKEN, which the project's check refuses; "After" depends on it.
  test.use({
    appOptions: {
      taskScript: byInstruction,
      buildPlan: { tasks: [card('Broken', 'WRITE BROKEN: x', ['broken/']), card('After', 'WRITE AFTER.md: after', ['after/'], [1])], commands: ['npm test'], checks: ['node check.cjs'] },
    },
  });

  test('the board says it was skipped because the card it depends on waits (review of M4)', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF, 'check.cjs': "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0);\n" });
    await goTo(page, app, '#/projects/garden');
    await page.getByTestId('build-implement').click();
    await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
    await page.getByTestId('build-fix-rounds').fill('0');
    await start(page);
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-column-waiting').getByTestId('build-card')).toContainText('Broken');
    const skipped = page.getByTestId('build-column-skipped').getByTestId('build-card');
    await expect(skipped).toHaveCount(1);
    await expect(skipped.getByTestId('build-card-skipped')).toHaveText('Skipped: it depends on card 1, which was not done.');
  });
});

test.describe('a cancelled card', () => {
  test.use({ appOptions: { taskScript: byInstruction, buildPlan: board([card('Slow', 'WAIT 60000\nWRITE SLOW.md: slow', ['slow/'])]) } });

  test('the board shows it under Skipped, cancelled with the build (review of M4)', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await plan(page, app);
    await start(page);
    await expect(page.getByTestId('build-column-running').getByTestId('build-card')).toHaveCount(1, SLOW);
    await page.getByTestId('build-cancel').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Cancelled', SLOW);
    await expect(page.getByTestId('build-column-skipped').getByTestId('build-card-skipped')).toHaveText('Cancelled with the build.');
  });
});

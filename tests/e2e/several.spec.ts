import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, test, type App } from './fixtures.js';

// Several creations at the same time (BRIEF-phase-4 §3.2), over the fake runner.

async function startCreation(page: Page, app: App, idea: string): Promise<string> {
  await page.goto(app.url);
  await page.getByRole('navigation', { name: /^(Main|Principal)$/ }).getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Describe your idea').fill(idea);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('idea')).toHaveText(idea);
  const id = app.manager.list().find((creation) => creation.idea === idea)?.id;
  if (id === undefined) throw new Error('no such creation');
  return id;
}

/** Settles when the creation has finished and its stream has sent everything: a condition, not a deadline. */
const ended = (app: App, id: string): Promise<void> =>
  new Promise((resolve) => {
    app.manager.subscribe(id, 0, () => undefined, resolve);
  });

const question = (text: string) =>
  JSON.stringify({
    do: 'question',
    questions: [{ question: text, header: 'Q', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }],
  });

test.describe('two creations at once', () => {
  test('each keeps its own questions, controls and panel', async ({ page, app, context }) => {
    const first = await startCreation(page, app, 'A garden planner');
    const other = await context.newPage();
    const second = await startCreation(other, app, 'A recipe box');

    // Each page asks for its own creation, and says so.
    await expect(page.getByTestId('pending-for')).toHaveText('For the creation: A garden planner');
    await expect(other.getByTestId('pending-for')).toHaveText('For the creation: A recipe box');
    await expect(other.getByText('Who is the planner for?')).toBeVisible();

    // Answering the first moves only the first.
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(page.getByText('Which seasons should it cover?')).toBeVisible();
    expect(app.manager.get(first).pending?.id).toBe('p2');
    expect(app.manager.get(second).pending?.id).toBe('p1');
    await expect(other.getByText('Who is the planner for?')).toBeVisible();
    await expect(other.getByText('Which seasons should it cover?')).toHaveCount(0);

    // The Creations page lists both, each with what it waits for.
    await page.getByRole('link', { name: /Creations/ }).click();
    const rows = page.getByTestId('creations').getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'A garden planner' }).getByTestId('waiting')).toHaveText('your answers');
    await expect(rows.filter({ hasText: 'A recipe box' }).getByTestId('waiting')).toHaveText('your answers');
    await expect(page.getByTestId('creations-count')).toHaveText('2 of 2 at the same time.');
    await expect(page.getByRole('link', { name: /Creations/ }).getByRole('img', { name: '2 creations running' })).toHaveText('2');

    // Cancelling one leaves the other as it was.
    await rows.filter({ hasText: 'A recipe box' }).getByRole('link', { name: 'Open' }).click();
    await expect(page.getByTestId('idea')).toHaveText('A recipe box');
    await page.getByRole('button', { name: 'Cancel creation' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel creation' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'cancelled');
    expect(app.manager.get(first).status).toBe('waiting');
    expect(app.manager.get(first).pending?.id).toBe('p2');
  });
});

test.describe('two creations finishing together', () => {
  test.use({
    appOptions: {
      recordingText: [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"learn","phase":"started"}',
        '{"do":"wait","ms":300}',
        '{"do":"library","section":"lessons","text":"---\\nsummary: Lessons from a run.\\n---\\nDo not ask for the folder twice.\\n"}',
        '{"do":"flow","step":"learn","phase":"finished","outcome":"ok"}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    },
  });

  test('both library commits are there and the library is clean', async ({ page, app }) => {
    const before = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: app.libraryDir, encoding: 'utf8' }).trim());
    // Started together, so both write the library at the same moment.
    const [one, two] = await Promise.all([app.manager.create('One idea'), app.manager.create('Another idea')]);
    await Promise.all([ended(app, one.id), ended(app, two.id)]);
    expect(app.manager.get(one.id).status).toBe('finished');
    expect(app.manager.get(one.id).outcome).toBe('completed');
    expect(app.manager.get(two.id).outcome).toBe('completed');

    const log = execFileSync('git', ['log', '--format=%s', `-${2}`], { cwd: app.libraryDir, encoding: 'utf8' }).trim().split('\n');
    expect(log).toEqual(['library: update lessons', 'library: update lessons']);
    expect(Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: app.libraryDir, encoding: 'utf8' }).trim())).toBe(before + 2);
    // Nothing half done (the fixture's hand-written legacy note is the only untracked file).
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: app.libraryDir, encoding: 'utf8' }).trim()).toBe('');
    // Opened once both are over, so the page reads the final list instead of waiting for its next check.
    await page.goto(app.url);
    await page.getByRole('link', { name: /Creations/ }).click();
    await expect(page.getByText('No creation is running.')).toBeVisible();
  });
});

test.describe('two creations and one folder', () => {
  test.use({
    appOptions: {
      recordingText: [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"interview","phase":"started"}',
        '{"do":"claim","dir":"garden","onRefused":"taken"}',
        question('Ready to go on?'),
        '{"do":"session","phase":"finished","outcome":"completed"}',
        '{"do":"label","name":"taken"}',
        question('That folder is in use by another creation. Use garden-2 instead?'),
        '{"do":"claim","dir":"garden-2"}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    },
  });

  test('the second is refused before it writes, says why on its panel, and asks for another folder', async ({ page, app, context }) => {
    await startCreation(page, app, 'A garden planner');
    await expect(page.getByText('Ready to go on?')).toBeVisible();

    const other = await context.newPage();
    await startCreation(other, app, 'A second garden');
    await expect(other.getByText('That folder is in use by another creation. Use garden-2 instead?')).toBeVisible();
    const main = other.getByTestId('agent-main');
    await expect(main.getByTestId('denial-count')).toContainText('1');
    await main.click();
    await expect(other.getByTestId('panel-denials')).toContainText('Another creation in progress ("A garden planner")');
    await expect(other.getByTestId('panel-denials')).toContainText('Ask the user for another folder');
    // The first one was not touched.
    await expect(page.getByText('Ready to go on?')).toBeVisible();
  });
});

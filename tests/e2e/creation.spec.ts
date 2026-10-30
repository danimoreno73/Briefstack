import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { updateConfig } from '../../src/config/index.js';
import type { StreamEvent } from '../../src/creation/manager.js';
import { FAKE_KEY, expect, recordProject, test, type App } from './fixtures.js';

/** Everything the manager has streamed for the first creation, from the start. */
function history(app: App): StreamEvent[] {
  const id = app.manager.list()[0]?.id;
  const events: StreamEvent[] = [];
  if (id !== undefined) app.manager.subscribe(id, 0, (event) => events.push(event), () => undefined)();
  return events;
}

const answeredAnswers = (app: App, kind: string): unknown[] =>
  history(app)
    .filter((event) => event.kind === kind && 'state' in event.data && event.data.state === 'answered')
    .map((event) => ('answer' in event.data ? event.data.answer : undefined));

const sessionId = async (app: App): Promise<string> => {
  for (let i = 0; i < 100; i += 1) {
    const id = app.manager.list()[0]?.sessionId;
    if (id !== undefined) return id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the creation has no session yet');
};

async function startCreation(page: Page, app: App, idea = 'A garden planner'): Promise<void> {
  await page.goto(app.url);
  await page.getByRole('navigation', { name: /^(Main|Principal)$/ }).getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Describe your idea').fill(idea);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('idea')).toHaveText(idea);
}

const step = (page: Page, name: string) => page.getByTestId('progress').getByRole('listitem').filter({ hasText: name });
const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel creation' }).first();
const sendAnswers = (page: Page) => page.getByRole('button', { name: 'Send answers' }).click();

/** The page as a reader sees it: visible text plus every attribute. Field values are in neither. */
const everywhere = (page: Page): Promise<string> =>
  page.evaluate(() => `${document.body.innerText}\n${document.documentElement.outerHTML}`);

test.describe('a whole creation', () => {
  test('answers the questions, approves the spec, allows a request and shows the project', async ({ page, app }) => {
    await startCreation(page, app);

    // The questions: the recommended option is already picked, and Cancel is there.
    await expect(page.getByRole('heading', { name: 'The flow needs your answers' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Just me \(Recommended\)/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /My family/ })).not.toBeChecked();
    await expect(page.getByRole('radio', { name: /garden-planner \(Recommended\)/ })).toBeChecked();
    await expect(cancelButton(page)).toBeVisible();
    await expect(step(page, 'Interview')).toHaveAttribute('data-state', 'running');
    await expect(step(page, 'Idea')).toHaveAttribute('data-state', 'ok');
    await expect(step(page, 'Gap analysis')).toHaveAttribute('data-state', 'ok');
    await expect(step(page, 'Generate')).toHaveAttribute('data-state', 'waiting');

    // Pick another option for the first question and write an own answer for the second.
    await page.getByRole('radio', { name: /My family/ }).check();
    await page.getByLabel('Or write your own answer').nth(1).fill('my-garden');
    await sendAnswers(page);

    // The second batch.
    await expect(page.getByText('Which seasons should it cover?')).toBeVisible();
    await expect(page.getByRole('radio', { name: /All four \(Recommended\)/ })).toBeChecked();
    await sendAnswers(page);
    expect(answeredAnswers(app, 'question')).toEqual([
      { 'Who is the planner for?': 'My family', 'Where should the project be created?': 'my-garden' },
      { 'Which seasons should it cover?': 'All four (Recommended)' },
    ]);

    // The spec.
    await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
    await expect(page.getByTestId('spec-summary')).toContainText('A planting calendar for a home gardener.');
    await expect(page.getByTestId('spec-fields')).toContainText('Garden planner');
    await expect(step(page, 'Spec')).toHaveAttribute('data-state', 'running');
    await expect(cancelButton(page)).toBeVisible();
    // What the skill's learn step records, before the end.
    await recordProject(app, 'garden-planner', 'Garden planner', await sessionId(app));
    await page.getByRole('button', { name: 'Approve' }).click();

    // The permission request shows exactly what is asked, and who asks.
    await expect(page.getByRole('dialog', { name: 'Permission request' })).toBeVisible();
    await expect(page.getByTestId('permission-summary')).toHaveText('git status');
    await expect(page.getByText('Asked by the generator agent')).toBeVisible();
    await expect(step(page, 'Generate')).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('agents')).toContainText('generator');
    await expect(cancelButton(page)).toBeVisible();
    await page.getByRole('button', { name: 'Allow' }).click();
    expect(answeredAnswers(app, 'permission')).toEqual(['allow']);

    // The result.
    const result = page.getByTestId('result');
    await expect(result).toHaveAttribute('data-outcome', 'completed');
    await expect(result).toContainText('Your project is ready.');
    const card = page.getByTestId('project-card');
    await expect(card).toContainText('Garden planner');
    await expect(card).toContainText('claude-code');
    await expect(card).toContainText('garden-planner');
    await expect(page.getByRole('button', { name: 'Cancel creation' })).toHaveCount(0);
    for (const name of ['Idea', 'Interview', 'Spec', 'Generate', 'Hand-off']) await expect(step(page, name)).toHaveAttribute('data-state', 'ok');
    await expect(step(page, 'Research')).toHaveAttribute('data-state', 'skipped');
    await expect(page.getByTestId('denied')).toHaveCount(0);

    // Its page has the creation history.
    await card.getByRole('link', { name: 'Open the project page' }).click();
    await expect(page.getByRole('heading', { name: 'Garden planner', level: 1 })).toBeVisible();
    await expect(page.getByTestId('timeline')).toContainText('Interview');
  });
});

test.describe('change at the spec', () => {
  test.use({ appOptions: { recording: 'change-at-spec.jsonl' } });

  test('a change request comes back to the spec screen, and approving ends the creation', async ({ page, app }) => {
    await startCreation(page, app, 'A novel workspace');
    await sendAnswers(page);

    await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
    await expect(page.getByTestId('spec-summary')).toContainText('Novel workspace');
    // Changing needs text.
    await page.getByRole('button', { name: 'Request changes' }).click();
    await expect(page.getByRole('button', { name: 'Send changes' })).toBeDisabled();
    await page.getByLabel('What should change?').fill('Name it Novel desk');
    await page.getByRole('button', { name: 'Send changes' }).click();

    // The flow sends it to the architect and asks again: a new request, the same screen.
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByLabel('What should change?')).toHaveCount(0);
    const count = page.getByRole('link', { name: /^Sessions/ }).getByRole('img', { name: '1 creation running' });
    await expect(count).toHaveText('1');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed');
    expect(answeredAnswers(app, 'spec')).toEqual([{ decision: 'change', text: 'Name it Novel desk' }, { decision: 'approve' }]);
    // The menu's count goes with the creation, not at the next 4 s check (audit L3).
    await expect(count).toHaveCount(0, { timeout: 2000 });
  });
});

test.describe('cancelling', () => {
  test('asks first, and then ends the session as cancelled through the flow', async ({ page, app }) => {
    await startCreation(page, app);
    await expect(page.getByRole('heading', { name: 'The flow needs your answers' })).toBeVisible();

    await cancelButton(page).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this creation?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('closes the session as cancelled');
    await dialog.getByRole('button', { name: 'Keep going' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'The flow needs your answers' })).toBeVisible();
    expect(app.manager.list()[0]?.status).toBe('waiting');

    await cancelButton(page).click();
    await dialog.getByRole('button', { name: 'Cancel creation' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'cancelled');
    await expect(page.getByTestId('result')).toContainText('The creation was cancelled.');
    await expect(page.getByRole('button', { name: 'Cancel creation' })).toHaveCount(0);

    // The flow closed the open step and the session; nothing was killed.
    const events = await readFile(path.join(app.sessionsDir, await sessionId(app), 'events.jsonl'), 'utf8');
    expect(events).toContain('"type":"step.finished","step":"interview","outcome":"skipped"');
    expect(events).toContain('"type":"session.finished","outcome":"cancelled"');
    expect(events).not.toContain('server_stop');
    await expect(step(page, 'Interview')).toHaveAttribute('data-state', 'skipped');
  });

  test('cancelling the spec screen asks first as well', async ({ page, app }) => {
    await startCreation(page, app);
    await sendAnswers(page);
    await sendAnswers(page);
    await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
    // Two buttons say Cancel here (the panel's and the page's); both ask.
    await page.getByRole('group', { name: 'Approve the spec' }).getByRole('button', { name: 'Cancel creation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this creation?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep going' }).click();
    await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
    await page.getByRole('group', { name: 'Approve the spec' }).getByRole('button', { name: 'Cancel creation' }).click();
    await dialog.getByRole('button', { name: 'Cancel creation' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'cancelled');
    expect(answeredAnswers(app, 'spec')).toEqual([{ decision: 'cancel' }]);
  });

  test.describe('while it works', () => {
    test.use({ appOptions: { recording: 'working.jsonl' } });

    test('stops at the next step and closes the session', async ({ page, app }) => {
      await startCreation(page, app);
      await expect(page.getByTestId('working')).toContainText('Working');
      await expect(step(page, 'Generate')).toHaveAttribute('data-state', 'running');
      await expect(page.getByTestId('agents')).toContainText('generator');
      await cancelButton(page).click();
      await page.getByRole('dialog', { name: 'Cancel this creation?' }).getByRole('button', { name: 'Cancel creation' }).click();
      await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'cancelled');
      const events = await readFile(path.join(app.sessionsDir, await sessionId(app), 'events.jsonl'), 'utf8');
      expect(events).toContain('"type":"session.finished","outcome":"cancelled"');
    });
  });
});

test.describe('a turn that ends with nothing asked', () => {
  test.use({
    appOptions: {
      recordingText: [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"interview","phase":"started"}',
        '{"do":"turnEnd","message":"Which **name** do you want for the project?"}',
        '{"do":"question","questions":[{"question":"Shall I go on with that name?","header":"Name","options":[{"label":"Yes","description":""},{"label":"No","description":""}],"multiSelect":false}]}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    },
  });

  test('the user replies in free text from the page and the flow goes on', async ({ page, app }) => {
    await startCreation(page, app);
    const waiting = page.getByTestId('awaiting-reply');
    await expect(waiting).toContainText('Which name do you want for the project?');
    await expect(waiting.getByTestId('pending-for')).toHaveCount(0);
    await expect(waiting.locator('.pending-for')).toHaveText('For the creation: A garden planner');
    const box = waiting.getByLabel('Your reply');
    await expect(waiting.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    await box.fill('Call it Seedling');
    // Ctrl+Enter sends, as the hint says.
    await box.press('Control+Enter');
    await expect(page.getByText('Shall I go on with that name?')).toBeVisible();
    await expect(page.getByTestId('awaiting-reply')).toHaveCount(0);
    expect(app.manager.list()[0]?.awaitingReply).toBeUndefined();
  });
});

test.describe('closing and reopening the tab', () => {
  test('the creation goes on, and the app shows it again', async ({ page, app, context }) => {
    await startCreation(page, app);
    await sendAnswers(page);
    await expect(page.getByText('Which seasons should it cover?')).toBeVisible();
    await page.close();

    // Nothing ended.
    expect(app.manager.list()[0]?.status).toBe('waiting');

    const reopened = await context.newPage();
    await reopened.goto(app.url);
    await expect(reopened.getByRole('link', { name: /^Sessions/ }).getByRole('img', { name: '1 creation running' })).toHaveText('1');
    await reopened.getByRole('link', { name: /^Sessions/ }).click();
    await expect(reopened.getByTestId('creations').getByTestId('waiting')).toHaveText('your answers');
    await reopened.getByTestId('creations').getByRole('link', { name: 'Open' }).click();
    // The creation in progress, not an empty form, with what was already done.
    await expect(reopened.getByTestId('idea')).toHaveText('A garden planner');
    await expect(reopened.getByText('Which seasons should it cover?')).toBeVisible();
    await expect(step(reopened, 'Gap analysis')).toHaveAttribute('data-state', 'ok');
    await expect(step(reopened, 'Interview')).toHaveAttribute('data-state', 'running');
    expect(reopened.url()).toContain('#/new/');

    // And F5 keeps it.
    await reopened.reload();
    await expect(reopened.getByText('Which seasons should it cover?')).toBeVisible();
    await sendAnswers(reopened);
    await expect(reopened.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
  });

  test('the form says plan usage adds up while one runs, and a stale form over the limit says so', async ({ page, app, context }) => {
    await updateConfig(path.join(app.home, 'config.json'), { maxActiveCreations: 1 });
    // This tab has the empty form open.
    await page.goto(app.url);
    await page.getByRole('navigation', { name: /^(Main|Principal)$/ }).getByRole('link', { name: 'New project' }).click();
    await page.getByLabel('Describe your idea').fill('A second idea');
    await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
    await expect(page.getByTestId('usage-adds-up')).toHaveCount(0);

    // Another tab starts a creation.
    const other = await context.newPage();
    await startCreation(other, app, 'The first idea');
    await expect(other.getByRole('heading', { name: 'The flow needs your answers' })).toBeVisible();
    await other.getByRole('navigation', { name: /^(Main|Principal)$/ }).getByRole('link', { name: 'New project' }).click();
    await expect(other.getByTestId('usage-adds-up')).toContainText('One creation is already running.');

    await page.getByRole('button', { name: 'Start' }).click();
    const limit = page.getByTestId('limit-reached');
    await expect(limit).toContainText('The limit of creations at the same time is reached.');
    await limit.getByRole('link', { name: 'See the creations' }).click();
    await expect(page.getByTestId('creations')).toContainText('The first idea');
    await expect(page.getByTestId('creations-count')).toHaveText('1 of 1 at the same time.');
    expect(app.manager.list()).toHaveLength(1);
  });
});

test.describe('requests nobody pre-approved', () => {
  test.use({ appOptions: { recording: 'permissions.jsonl' } });

  test('asks about each one, and lists what the guard refused', async ({ page, app }) => {
    await startCreation(page, app);
    await expect(page.getByTestId('permission-summary')).toHaveText('git status');
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByTestId('permission-summary')).toHaveText('https://example.com/docs');
    await expect(page.getByText('Asked by the main session')).toBeVisible();
    await page.getByRole('button', { name: 'Allow' }).click();
    expect(answeredAnswers(app, 'permission')).toEqual(['deny', 'allow']);

    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed');
    // What was answered is not "denied without asking"; the guard's refusal is.
    const denied = page.getByTestId('denied');
    await expect(denied.getByRole('listitem')).toHaveCount(1);
    await expect(denied).toContainText('rm -rf /');
    await expect(denied).toContainText('Not a briefstack command.');
  });
});

test.describe('the unattended policy', () => {
  test.use({ appOptions: { recording: 'permissions.jsonl', policy: 'unattended' } });

  test('denies by itself, never asks, and lists every denial on the result screen', async ({ page, app }) => {
    await startCreation(page, app);
    await expect(page.getByText('denied automatically (unattended)')).toBeVisible();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed');
    await expect(page.getByRole('dialog', { name: 'Permission request' })).toHaveCount(0);
    const denied = page.getByTestId('denied');
    await expect(denied.getByRole('listitem')).toHaveCount(3);
    await expect(denied).toContainText('git status');
    await expect(denied).toContainText('generator');
    await expect(denied).toContainText('https://example.com/docs');
    await expect(denied).toContainText('Denied automatically because the permission policy is unattended.');
    await expect(denied).toContainText('rm -rf /');
    expect(answeredAnswers(app, 'permission')).toEqual([]);
  });
});

test.describe('an output folder outside the projects folder', () => {
  test.use({ appOptions: { recording: 'grant.jsonl' } });

  test('asks to allow it, for this creation only, and goes on once answered', async ({ page, app }) => {
    await startCreation(page, app);
    await expect(page.getByRole('heading', { name: 'Allow an output folder' })).toBeVisible();
    await expect(page.getByTestId('grant-dir')).toContainText('out');
    await expect(page.getByText('for this creation only')).toBeVisible();
    await expect(cancelButton(page)).toBeVisible();
    await page.getByRole('button', { name: 'Allow this folder' }).click();
    expect(answeredAnswers(app, 'grant')).toEqual([true]);
    await expect(page.getByRole('heading', { name: 'Allow an output folder' })).toHaveCount(0);
    await expect(step(page, 'Interview')).toHaveAttribute('data-state', 'ok');
    await cancelButton(page).click();
    await page.getByRole('dialog', { name: 'Cancel this creation?' }).getByRole('button', { name: 'Cancel creation' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'cancelled');
  });

  test('a refusal is sent as no', async ({ page, app }) => {
    await startCreation(page, app);
    await page.getByRole('button', { name: 'Do not allow' }).click();
    await expect(page.getByRole('heading', { name: 'Allow an output folder' })).toHaveCount(0);
    expect(answeredAnswers(app, 'grant')).toEqual([false]);
  });
});

test.describe('secrets in a permission request', () => {
  const recording = [
    '{"do":"session","phase":"started"}',
    '{"do":"flow","step":"generate","phase":"started"}',
    JSON.stringify({ do: 'permission', toolName: 'Bash', summary: `curl -H "x-api-key: ${FAKE_KEY}" https://example.com`, agentType: 'generator' }),
    '{"do":"wait","ms":60000}',
  ].join(String.fromCharCode(10));
  test.use({ appOptions: { recordingText: recording } });

  test('never reach the page', async ({ page, app }) => {
    await startCreation(page, app);
    await expect(page.getByRole('dialog', { name: 'Permission request' })).toBeVisible();
    await expect(page.getByTestId('permission-summary')).toContainText('[redacted]');
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
    await page.reload();
    await expect(page.getByTestId('permission-summary')).toContainText('[redacted]');
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
  });
});

test.describe('a turn that ends with nothing asked on the page', () => {
  const recording = [
    '{"do":"session","phase":"started"}',
    '{"do":"flow","step":"spec","phase":"started"}',
    JSON.stringify({ do: 'emit', event: { kind: 'status', status: 'turnEnded', message: `**Do you approve it?**\nkey: ${FAKE_KEY}` } }),
    '{"do":"wait","ms":60000}',
  ].join(String.fromCharCode(10));
  test.use({ appOptions: { recordingText: recording } });

  test('shows the last message, redacted, and says the session waits, not that it is working', async ({ page, app }) => {
    await startCreation(page, app);
    const panel = page.getByTestId('awaiting-reply');
    await expect(panel.getByRole('heading', { name: 'The session is waiting for a reply' })).toBeVisible();
    await expect(panel.locator('strong')).toHaveText('Do you approve it?');
    await expect(page.getByTestId('working')).toHaveCount(0);
    await expect(cancelButton(page)).toBeVisible();
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
    await page.reload();
    await expect(page.getByTestId('awaiting-reply')).toContainText('Do you approve it?');
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
  });
});

test.describe('in Spanish', () => {
  test.use({ appOptions: { lang: 'es' } });

  test('shows the flow in the saved language', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('navigation', { name: /^(Main|Principal)$/ }).getByRole('link', { name: 'Proyecto nuevo' }).click();
    await page.getByLabel('Describe tu idea').fill('Un planificador');
    await page.getByRole('button', { name: 'Empezar' }).click();
    await expect(page.getByRole('heading', { name: 'El flujo necesita tus respuestas' })).toBeVisible();
    await expect(step(page, 'Entrevista')).toHaveAttribute('data-state', 'running');
    await expect(page.getByRole('button', { name: 'Cancelar creación' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar creación' }).first().click();
    await expect(page.getByRole('dialog', { name: '¿Cancelar esta creación?' })).toBeVisible();
  });
});

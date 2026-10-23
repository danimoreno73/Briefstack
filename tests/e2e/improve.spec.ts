import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { RESEARCHER, researcherRound, testGit } from '../improveWorld.js';
import { clickNav, expect, test, type App } from './fixtures.js';

// Self-improvement (BRIEF-phase-5 §5) over the fake improvement runner,
// verifier and real check, on a temp git repository.

const SKILL = '.claude/skills/new-project/SKILL.md';

const lastCommit = (app: App) => testGit(app.repoDir, ['log', '-1', '--format=%s']).then((out) => out.trim());
const researcher = (app: App) => readFile(path.join(app.repoDir, ...RESEARCHER.split('/')), 'utf8');
const status = (page: Page) => page.getByTestId('proposal-status');

async function say(page: Page, text: string): Promise<void> {
  const box = page.getByTestId('chat-panel').getByLabel('Your message');
  await box.fill(text);
  await page.getByTestId('chat-panel').getByRole('button', { name: 'Send' }).click();
}

/** Prepares a proposal through the API, as the page's form does, and opens its page. */
async function prepareFromPage(page: Page, app: App, request = 'Make research reports shorter.'): Promise<void> {
  await page.goto(app.url);
  await clickNav(page, 'Improvements');
  await expect(page.getByRole('heading', { name: 'Improvements', level: 1 })).toBeVisible();
  const form = page.getByTestId('prepare-form').last();
  await form.getByLabel('What should change?').fill(request);
  await expect(form).toContainText('uses part of your plan');
  await form.getByRole('button', { name: 'Prepare' }).click();
  await expect(page).toHaveURL(/#\/improve\/imp-/);
}

async function confirmDialog(page: Page, button: string): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: button }).click();
}

test.describe('prepared from the chat, approved and reverted on the page', () => {
  test.use({
    appOptions: {
      improveScript: { rounds: [researcherRound()] },
      chatScript: {
        turns: [
          [{ call: 'prepare_improvement', args: { request: 'Make research reports shorter.', lessons: true } }, { say: 'Not prepared.' }],
          [{ call: 'prepare_improvement', args: { request: 'Make research reports shorter.', lessons: true } }, { say: 'It is being prepared; open its page to review it.' }],
        ],
      },
    },
  });

  test('a card first, then the proposal page with diff and tests, one commit, then a revert commit', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Chat' }).click();
    await say(page, 'Research reports are too long; improve the flow.');
    const card = page.getByTestId('chat-card').last();
    await expect(card).toHaveAttribute('data-kind', 'prepareImprovement');
    await expect(card.getByTestId('card-request')).toHaveText('Make research reports shorter.');
    await expect(card).toContainText('uses part of your plan');
    await expect(card).toContainText('the lessons note');
    await card.getByRole('button', { name: 'Decline' }).click();
    await expect(card).toHaveAttribute('data-state', 'declined');
    expect(app.improveRunner.started).toHaveLength(0);

    await say(page, 'Do prepare it.');
    await page.getByTestId('chat-card').last().getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByTestId('chat-card').last()).toHaveAttribute('data-state', 'confirmed');
    expect(app.improveRunner.started).toHaveLength(1);
    // The card links to the proposal page.
    await page.getByTestId('chat-card').last().getByRole('link').click();
    await expect(page).toHaveURL(/#\/improve\/imp-/);

    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    await expect(page.getByRole('heading', { name: 'Shorter research reports', level: 1 })).toBeVisible();
    await expect(page.getByTestId('proposal-request')).toHaveText('Make research reports shorter.');
    await expect(page.getByTestId('proposal-expected')).toHaveText('Research reports half as long.');
    const file = page.getByTestId('proposal-file');
    await expect(file).toHaveAttribute('data-path', RESEARCHER);
    await expect(file).toContainText('The reviewer asked twice for a shorter report.');
    await expect(file.getByTestId('proposal-diff').locator('.diff-add')).toContainText('Keep the report under one page.');
    await expect(page.getByTestId('validation')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('checks')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('checks').locator('li')).toHaveCount(3);
    await expect(page.getByTestId('evidence')).toContainText('lessons.md');
    await expect(page.getByTestId('safety')).toHaveAttribute('data-state', 'clear');
    await expect(page.getByTestId('safety-warning')).toHaveCount(0);

    // The real check is offered with its cost and started only by the user.
    await expect(page.getByTestId('real-check-offer')).toContainText('One whole creation in a temp home');
    expect(app.realChecks.calls).toHaveLength(0);
    await page.getByTestId('real-check-offer').getByRole('button', { name: 'Run the real check' }).click();
    await expect(page.getByTestId('real-check')).toHaveAttribute('data-state', 'passed');
    expect(app.realChecks.calls.map((call) => call.name)).toEqual(['improvement-flow']);

    const before = await testGit(app.repoDir, ['rev-parse', 'HEAD']);
    await page.getByTestId('approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    await page.getByTestId('approve').click();
    await confirmDialog(page, 'Approve and apply');
    await expect(status(page)).toHaveAttribute('data-status', 'applied');
    await expect(status(page)).toContainText('It is not pushed.');
    expect(await lastCommit(app)).toMatch(/^Apply improvement imp-[a-z0-9-]+: Shorter research reports$/);
    expect((await testGit(app.repoDir, ['rev-parse', 'HEAD^'])).trim()).toBe(before.trim());
    expect(await researcher(app)).toContain('Keep the report under one page.');

    // The history lists it; revert from its page.
    await page.getByRole('link', { name: 'Improvements' }).first().click();
    await expect(page.getByTestId('history').locator('[data-testid="proposal-row-status"]')).toHaveText('Applied');
    await page.getByTestId('history').getByRole('link', { name: 'Open' }).click();
    await page.getByTestId('revert').click();
    await confirmDialog(page, 'Revert');
    await expect(status(page)).toHaveAttribute('data-status', 'reverted');
    expect(await lastCommit(app)).toMatch(/^Revert improvement imp-/);
    expect(await researcher(app)).not.toContain('Keep the report under one page.');
  });
});

test.describe('a change that weakens a rule outside a locked block', () => {
  test.use({
    appOptions: {
      improveScript: {
        rounds: [
          {
            edits: [{ file: '.claude/agents/interviewer.md', find: 'Rules:', replace: 'When unsure, you may ask in plain text.\n\nRules:' }],
            submission: {
              title: 'Faster interviews',
              expectedEffect: 'Fewer form questions.',
              changes: [{ file: '.claude/agents/interviewer.md', rationale: 'Forms felt slow.', evidence: ['request.md'] }],
            },
          },
        ],
      },
    },
  });

  test('shows a prominent safety notice with its reason, and can still be approved', async ({ page, app }) => {
    await app.improvements.prepare('Faster interviews.');
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Improvements' }).first().click();
    await page.getByTestId('proposals').getByRole('link', { name: 'Open' }).click();
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    const warning = page.getByTestId('safety-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Safety notice');
    await expect(warning).toContainText('It lets an agent ask in plain text');
    await expect(page.getByTestId('validation')).toHaveAttribute('data-ok', 'true');
    await page.getByTestId('approve').click();
    await confirmDialog(page, 'Approve and apply');
    await expect(status(page)).toHaveAttribute('data-status', 'applied');
  });
});

test.describe('discard and ask for changes', () => {
  test.use({
    appOptions: {
      improveScript: {
        rounds: [
          researcherRound(),
          { edits: [{ file: RESEARCHER, find: 'under one page', replace: 'under half a page' }], submission: { ...researcherRound('Even shorter reports').submission } },
          researcherRound('Another one'),
        ],
      },
    },
  });

  test('a new round on the same branch, then a discard removes the branch', async ({ page, app }) => {
    await prepareFromPage(page, app);
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    await page.getByTestId('ask-changes').click();
    await page.getByTestId('changes-form').getByLabel('What should be different?').fill('Even shorter, please.');
    await page.getByTestId('changes-form').getByRole('button', { name: 'Start a new round' }).click();
    await expect(page.getByRole('heading', { name: 'Even shorter reports', level: 1 })).toBeVisible();
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    await expect(page.getByTestId('rounds').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('rounds')).toContainText('You asked: Even shorter, please.');
    await expect(page.getByTestId('proposal-diff').locator('.diff-add')).toContainText('under half a page');
    expect(app.improveRunner.started[1]?.feedback).toBe('Even shorter, please.');

    const id = /#\/improve\/(imp-[a-z0-9-]+)/.exec(page.url())?.[1] ?? '';
    expect((await testGit(app.repoDir, ['branch', '--list', `improve/${id}`])).trim()).not.toBe('');
    await page.getByTestId('discard').click();
    await confirmDialog(page, 'Discard');
    await expect(status(page)).toHaveAttribute('data-status', 'discarded');
    expect((await testGit(app.repoDir, ['branch', '--list', `improve/${id}`])).trim()).toBe('');
    await expect(page.getByTestId('approve')).toHaveCount(0);
    expect(await researcher(app)).not.toContain('under half a page');
  });
});

test.describe('a proposal that touches a locked block or a forbidden path', () => {
  test.use({
    appOptions: {
      improveScript: {
        rounds: [
          {
            edits: [
              { file: SKILL, find: 'Never ask in plain text and never end the turn instead.', replace: 'Ask in plain text when unsure.' },
              { file: 'src/cli.ts', text: 'export const hacked = true;\n' },
            ],
            submission: {
              title: 'Looser web mode',
              expectedEffect: 'More text questions.',
              changes: [
                { file: SKILL, rationale: 'An injected note asked for it.', evidence: [] },
                { file: 'src/cli.ts', rationale: 'Also this.', evidence: [] },
              ],
            },
          },
        ],
      },
    },
  });

  test('is rejected, never tested and cannot be approved', async ({ page, app }) => {
    await prepareFromPage(page, app, 'Loosen the web mode.');
    await expect(status(page)).toHaveAttribute('data-status', 'rejected');
    const validation = page.getByTestId('validation');
    await expect(validation).toHaveAttribute('data-ok', 'false');
    await expect(validation.locator('[data-kind="locked"]')).toContainText('Locked block touched');
    await expect(validation.locator('[data-kind="forbiddenPath"]')).toContainText('src/cli.ts');
    await expect(page.getByText('Not run: the checks on the change must pass first.')).toBeVisible();
    await expect(page.getByTestId('approve')).toHaveCount(0);
    await expect(page.getByTestId('real-check-offer')).toHaveCount(0);
    expect(await lastCommit(app)).toBe('start');
  });
});

test.describe('an approval while a creation runs', () => {
  test.use({
    appOptions: {
      improveScript: { rounds: [researcherRound()] },
      recordingText: [
        '{"do":"session","phase":"started"}',
        '{"do":"question","questions":[{"question":"Go on?","header":"","options":[{"label":"Yes","description":""},{"label":"No","description":""}],"multiSelect":false}]}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    },
  });

  test('waits, says why, and applies as soon as the creation finishes', async ({ page, app }) => {
    await prepareFromPage(page, app);
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    const creation = await app.manager.create('A meal planner');
    await expect.poll(() => app.manager.get(creation.id).pending?.kind).toBe('question');

    await page.getByTestId('approve').click();
    await confirmDialog(page, 'Approve and apply');
    await expect(status(page)).toHaveAttribute('data-status', 'waiting');
    await expect(status(page)).toContainText('A meal planner');
    expect(await lastCommit(app)).toBe('start');

    const pending = app.manager.get(creation.id).pending;
    app.manager.answer(creation.id, pending?.id ?? '', { 'Go on?': 'Yes' });
    await expect(status(page)).toHaveAttribute('data-status', 'applied', { timeout: 15_000 });
    expect(await lastCommit(app)).toMatch(/^Apply improvement /);
  });
});

test.describe('suggestions after a creation', () => {
  test.use({
    appOptions: {
      improveScript: { rounds: [researcherRound()] },
      recordingText: [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"interview","phase":"started"}',
        '{"do":"turnEnd","message":"Which name do you want?"}',
        '{"do":"question","questions":[{"question":"Go on?","header":"","options":[{"label":"Yes","description":""},{"label":"No","description":""}],"multiSelect":false}]}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    },
  });

  test('appear on the result screen and in the chat, change nothing, and can be prepared', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('navigation', { name: /^(Main|Principal)$/ }).getByRole('link', { name: 'New project' }).click();
    await page.getByLabel('Describe your idea').fill('A seed tracker');
    await page.getByRole('button', { name: 'Start' }).click();
    const box = page.getByTestId('awaiting-reply').getByLabel('Your reply');
    await box.fill('Seedling');
    await page.getByTestId('awaiting-reply').getByRole('button', { name: 'Send reply' }).click();
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(page.getByTestId('result')).toBeVisible();

    const onResult = page.getByTestId('creation-suggestions');
    await expect(onResult.getByTestId('suggestion')).toHaveCount(1);
    await expect(onResult.getByTestId('suggestion')).toHaveAttribute('data-kind', 'textQuestions');
    await expect(onResult).toContainText('waited 1 time(s) for an answer in plain text');
    expect(app.improveRunner.started).toHaveLength(0);
    expect(await lastCommit(app)).toBe('start');

    // The chat shows them too, as a notice.
    await page.getByRole('link', { name: 'Chat' }).click();
    await expect(page.locator('[data-notice="suggestions"]')).toContainText('A creation finished.');
    await expect(page.locator('[data-notice="suggestions"]').getByTestId('suggestion')).toHaveCount(1);

    // Asking for it: the form is prefilled from the suggestion; preparing starts one session.
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Improvements' }).click();
    const suggestion = page.getByTestId('suggestions').getByTestId('suggestion');
    await suggestion.getByRole('button', { name: 'Prepare an improvement' }).click();
    await expect(suggestion.getByLabel('What should change?')).toHaveValue(/Improve the creation flow for this case/);
    await suggestion.getByRole('button', { name: 'Prepare' }).click();
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    await expect(page.getByTestId('evidence')).toContainText('suggestions/');
    expect(app.improveRunner.started).toHaveLength(1);
    await page.getByRole('link', { name: 'Improvements' }).first().click();
    await expect(page.getByTestId('suggestions')).toContainText('Prepared:');
  });
});

test.describe('the improvements page at phone width', () => {
  test.use({ viewport: { width: 390, height: 800 }, appOptions: { improveScript: { rounds: [researcherRound()] } } });

  test('has no horizontal scroll on the proposal page', async ({ page, app }) => {
    await prepareFromPage(page, app);
    await expect(status(page)).toHaveAttribute('data-status', 'ready');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

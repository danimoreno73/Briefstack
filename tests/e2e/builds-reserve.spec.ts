import type { Page } from '@playwright/test';
import type { TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { clickNav, codeProject, E2E_RESERVE_KEY, expect, test, type App } from './fixtures.js';

// Phase 12, M4: a build that goes on with a reserve provider at the usage
// threshold (BRIEF-phase-12 §5), over the fake planner and the fake task
// runner, which reads the fake provider's key file as the real runner does
// and sends it nowhere. Settings lists the provider, read-only.

const SLOW = { timeout: 30_000 };
const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- Notes.\n- A summary.\n';
const byTitle: TaskFakeScript = (_round, prompt) => {
  const title = /The task: (\w+)/.exec(prompt)?.[1] ?? 'Task';
  return { steps: [{ kind: 'write', file: `${title.toUpperCase()}.md`, content: `${title}.\n` }, { kind: 'end', summary: `Wrote ${title}.` }] };
};

async function goTo(page: Page, app: App, hash: string): Promise<void> {
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate((target) => (window.location.hash = target), hash);
}

test.describe('a build with a reserve provider', () => {
  // The first reading is over the 5-hour threshold, the second below it: Notes runs on the reserve, Summary on Claude.
  test.use({ appOptions: { taskScript: byTitle, reserveProvider: true, buildUsage: [{ kind: 'ok', fiveHour: 95, sevenDay: 10 }, { kind: 'ok', fiveHour: 20, sevenDay: 10 }] } });

  test('the start page warns, the build goes on with the reserve at the threshold, and each card shows its provider', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await goTo(page, app, '#/projects/garden');
    await page.getByTestId('build-implement').click();
    await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
    await page.getByTestId('build-no-checks-confirm').check();
    await expect(page.getByTestId('build-reserve')).toHaveValue('');
    await expect(page.getByTestId('build-reserve-warning')).toHaveCount(0);
    await page.getByTestId('build-reserve').selectOption('fake-reserve');
    await expect(page.getByTestId('build-reserve-warning')).toContainText('is billed per use to its key');
    await expect(page.getByTestId('build-reserve-warning')).toContainText('it receives the code, the prompts and the command output');
    await page.getByTestId('build-start').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
    await expect(page.getByTestId('build-state')).toHaveText('Finished', SLOW);
    await expect(page.getByTestId('build-task-state')).toHaveText(['Applied', 'Applied']);
    const rows = page.getByTestId('build-task-row');
    await expect(rows.nth(0).getByTestId('build-task-provider')).toHaveText('on fake-reserve');
    await expect(rows.nth(1).getByTestId('build-task-provider')).toHaveCount(0);
    expect(await page.content()).not.toContain(E2E_RESERVE_KEY);
    await expect(page.getByTestId('build-board-reserve')).toHaveText('At the usage threshold it goes on with the reserve provider fake-reserve.');
    // The build's API answer holds the provider's name, never its key (review of M4, I3).
    const id = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/builds\//, ''));
    const answer = await fetch(`http://127.0.0.1:${app.server.port}/api/builds/${encodeURIComponent(id)}`, { headers: { 'x-briefstack-token': app.server.token } });
    const body = await answer.text();
    expect(answer.status).toBe(200);
    expect(body).toContain('"reserve":"fake-reserve"');
    expect(body).not.toContain(E2E_RESERVE_KEY);
    const rounds = app.taskRunner.started.map((round) => round.provider?.name ?? 'claude');
    expect(rounds).toEqual(['fake-reserve', 'claude']);
  });

  test('Settings lists the provider without its key and checks it on a click', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Settings');
    const card = page.getByTestId('providers-card');
    await expect(card.getByTestId('provider')).toHaveCount(1);
    await expect(card).toContainText('fake-reserve');
    await expect(card).toContainText('https://reserve.e2e.invalid/anthropic');
    await expect(card.getByTestId('provider-check')).toHaveCount(0);
    await card.getByTestId('provider-check-button').click();
    // The fixtures' fake endpoint answers 404 without a key; the key file is there; the key is not checked.
    await expect(card.getByTestId('provider-key-file')).toHaveText('Key file: present', SLOW);
    await expect(card.getByTestId('provider-endpoint')).toHaveText('Endpoint: answers (HTTP 404)');
    await expect(card).toContainText('Key: not checked');
    expect(await page.content()).not.toContain(E2E_RESERVE_KEY);
  });
});

test('without reserve providers, the start page offers no choice and Settings no card', async ({ page, app }) => {
  await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
  await goTo(page, app, '#/projects/garden');
  await page.getByTestId('build-implement').click();
  await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
  await expect(page.getByTestId('build-threshold-week')).toBeVisible();
  await expect(page.getByTestId('build-reserve')).toHaveCount(0);
  await clickNav(page, 'Settings');
  await expect(page.getByTestId('claude-card')).toBeVisible();
  await expect(page.getByTestId('providers-card')).toHaveCount(0);
});

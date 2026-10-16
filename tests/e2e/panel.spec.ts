import type { Page } from '@playwright/test';
import { SESSION_CANCELLED, SESSION_DONE, SESSION_INTERRUPTED, expect, test, type App } from './fixtures.js';

async function startCreation(page: Page, app: App, idea = 'A garden planner'): Promise<void> {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Describe your idea').fill(idea);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('idea')).toHaveText(idea);
}

const panel = (page: Page) => page.getByTestId('agent-panel');
const node = (page: Page, id: string) => page.getByTestId(`agent-${id}`);
const textView = async (page: Page): Promise<string> => {
  const details = panel(page).locator('details.panel-text');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  return (await page.getByTestId('panel-text').innerText()).trim();
};

test.describe('the live panel', () => {
  test.use({ appOptions: { recording: 'panel.jsonl', planUsage: [{ fiveHour: 12, sevenDay: 40 }, { fiveHour: 15, sevenDay: 41 }] } });

  test('updates live, shows models, efforts and targets, and puts each request on the node that asked', async ({ page, app }) => {
    await startCreation(page, app);

    // The question: asked by the main session, which links to the form.
    await expect(node(page, 'main').getByTestId('node-pending')).toContainText('Asks you a question');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Waiting for you');
    await expect(node(page, 'main').getByTestId('agent-now')).toContainText('AskUserQuestion');
    await expect(node(page, 'main')).toContainText('opus · high');
    await expect(node(page, 'i1')).toContainText('interviewer');
    await expect(node(page, 'i1').getByTestId('node-status')).toHaveText('Done');
    await expect(node(page, 'i1')).toContainText('sonnet · medium');
    await expect(node(page, 'i1')).toContainText('1 tool call');
    await expect(node(page, 'i1').getByTestId('node-pending')).toHaveCount(0);
    await node(page, 'main').getByRole('button', { name: 'Go to the answer' }).click();
    await expect(page.getByRole('radio', { name: /Just me \(Recommended\)/ })).toBeFocused();

    // Plan usage at the start, never as tokens or cost.
    await expect(page.getByTestId('panel-usage')).toContainText('5-hour window 12% · 7-day window 40%');
    await expect(page.getByTestId('panel-usage')).not.toContainText(/\d\s*tokens|\$|€/i);

    await page.getByRole('button', { name: 'Send answers' }).click();

    // The spec: the architect was refused a write, with the guard's reason, and the target is not shown in full.
    await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
    await expect(node(page, 'a1').getByTestId('denial-count')).toHaveText('1 denied');
    await expect(node(page, 'main').getByTestId('node-pending')).toContainText('Asks you to approve the spec');
    await node(page, 'a1').getByRole('button', { name: /architect/ }).click();
    const detail = page.getByTestId('panel-detail');
    await expect(detail).toContainText('Details: architect');
    await expect(detail).toContainText('opus');
    await expect(page.getByTestId('panel-denials')).toContainText('Write by the guard');
    await expect(page.getByTestId('panel-denials')).toContainText('outside allowed folders');
    await expect(page.getByTestId('panel-denials')).toContainText('Writes are only allowed inside the projects folder');
    await page.getByRole('button', { name: 'Approve' }).click();

    // The permission: asked by the generator, which is waiting; the main session is not.
    const generator = node(page, 'g1');
    await expect(generator.getByTestId('node-pending')).toContainText('Asks for a permission');
    await expect(generator.getByTestId('node-status')).toHaveText('Waiting for you');
    await expect(generator.getByTestId('agent-now')).toContainText('Bash');
    await expect(generator.getByTestId('agent-now')).toContainText('briefstack validate');
    await expect(node(page, 'main').getByTestId('node-pending')).toHaveCount(0);
    await generator.getByRole('button', { name: 'Go to the answer' }).click();
    await expect(page.getByRole('button', { name: 'Allow' })).toBeFocused();
    await page.getByRole('button', { name: 'Allow' }).click();

    // The end: every node is done, nothing in use.
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed');
    for (const id of ['main', 'i1', 'a1', 'g1']) await expect(node(page, id).getByTestId('node-status')).toHaveText('Done');
    await expect(panel(page).getByTestId('agent-now').filter({ hasText: 'No tool in use' })).toHaveCount(4);
  });

  test('reopening the tab mid-creation rebuilds the panel without lost or duplicated events', async ({ page, app, context }) => {
    await startCreation(page, app);
    await page.getByRole('button', { name: 'Send answers' }).click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(node(page, 'g1').getByTestId('node-pending')).toBeVisible();
    const before = await textView(page);
    await page.close();

    // As a user does: the address with the launch token, then the creation in progress.
    const again = await context.newPage();
    await again.goto(app.url);
    await again.getByRole('link', { name: /New project/ }).click();
    await expect(node(again, 'g1').getByTestId('node-pending')).toBeVisible();
    const after = await textView(again);
    // Same lines, apart from running durations.
    const stable = (text: string) => text.replace(/\d+ (?:s|min|h)\b/g, 'N');
    expect(stable(after)).toBe(stable(before));
    expect(after).toContain('generator: Waiting for you');
    expect(after).toContain('2 tool calls');
    expect(after.split('\n')).toHaveLength(4);
  });
});

test.describe('a burst of events', () => {
  test.use({
    appOptions: {
      recordingText: [
        '{"do":"session","phase":"started"}',
        '{"do":"flow","step":"validate-review","phase":"started"}',
        '{"do":"hook","type":"subagent.start","agentId":"r1","agentType":"reviewer"}',
        '{"do":"burst","count":3000,"agentId":"r1","agentType":"reviewer","tool":"Read"}',
        '{"do":"question","questions":[{"question":"Keep going?","header":"Go","options":[{"label":"Yes (Recommended)","description":""},{"label":"No","description":""}],"multiSelect":false}]}',
        '{"do":"session","phase":"finished","outcome":"completed"}',
      ].join('\n'),
    },
  });

  test('does not freeze the page: the counts catch up and the controls answer', async ({ page, app }) => {
    await startCreation(page, app);
    await expect(node(page, 'r1')).toContainText('3000 tool calls', { timeout: 15_000 });
    await expect(page.getByRole('radio', { name: /Yes \(Recommended\)/ })).toBeChecked();
    await page.getByRole('radio', { name: 'No' }).check();
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed');
  });
});

test.describe('finished sessions', () => {
  test('a cancelled and an interrupted session open their panel from the projects page', async ({ page, app }) => {
    await page.goto(app.url);
    const unfinished = page.getByTestId('unfinished');
    await unfinished.getByRole('link', { name: SESSION_CANCELLED }).click();
    await expect(page.getByTestId('session-status')).toContainText('Cancelled');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Cancelled');
    await expect(page.locator('.steps-inline li[data-state="running"]')).toHaveCount(1);

    await page.goBack();
    await page.getByTestId('unfinished').getByRole('link', { name: SESSION_INTERRUPTED }).click();
    await expect(page.getByTestId('session-status')).toContainText('Interrupted');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Interrupted');
  });

  test('a session recorded before phase 3 still renders, from the project page', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Garden planner' }).click();
    await page.getByTestId('open-panel').click();
    await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_DONE}$`));
    await expect(page.getByTestId('session-status')).toContainText('Completed');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Done');
    await expect(page.getByTestId('panel-detail')).toContainText('Model');
    await expect(page.getByTestId('panel-usage')).toContainText('Not available for this session.');
    await expect(page.getByText('No subagent has started yet.')).toBeVisible();
  });

  test('a session with an agent that never stopped shows no end recorded', async ({ page, app }) => {
    const { appendEvent, sessionLifecycleEvent } = await import('../../src/events/index.js');
    const id = 'sess-no-end';
    const at = (s: string) => new Date(`2026-10-12T10:00:${s}Z`);
    await appendEvent(app.sessionsDir, sessionLifecycleEvent(id, 'started', undefined, at('00')));
    await appendEvent(app.sessionsDir, { v: 1, ts: at('01').toISOString(), session: id, source: 'hook', type: 'subagent.start', agentId: 'g1', agentType: 'generator' });
    await appendEvent(app.sessionsDir, sessionLifecycleEvent(id, 'finished', 'failed', at('09')));
    await page.goto(app.url);
    await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
    await page.evaluate((target) => (window.location.hash = target), `#/sessions/${id}`);
    await expect(node(page, 'g1').getByTestId('node-status')).toHaveText('No end recorded');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Failed');
  });
});

test.describe('the text alternative', () => {
  test.use({ appOptions: { recording: 'panel.jsonl' } });

  test('lists every agent, and the timeline is usable with the keyboard', async ({ page, app }) => {
    await startCreation(page, app);
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(node(page, 'a1')).toBeVisible();
    const text = await textView(page);
    expect(text).toContain('Main session: Waiting for you');
    expect(text).toContain('interviewer: Done');
    expect(text).toContain('architect: Done');
    expect(text).toContain('1 denied');

    const row = page.getByTestId('panel-timeline').getByRole('button', { name: /architect/ });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('panel-detail')).toContainText('Details: architect');
  });
});

test.describe('at a narrow width', () => {
  test.use({ viewport: { width: 390, height: 844 }, appOptions: { recording: 'panel.jsonl' } });

  test('the panel pages never scroll sideways', async ({ page, app }) => {
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await startCreation(page, app);
    await expect(node(page, 'main').getByTestId('node-pending')).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(node(page, 'a1').getByTestId('denial-count')).toBeVisible();
    await node(page, 'a1').getByRole('button', { name: /architect/ }).click();
    expect(await sideways()).toBeLessThanOrEqual(0);
    await page.evaluate((id) => (window.location.hash = `#/sessions/${id}`), SESSION_INTERRUPTED);
    await expect(page.getByTestId('session-status')).toContainText('Interrupted');
    expect(await sideways()).toBeLessThanOrEqual(0);
  });
});

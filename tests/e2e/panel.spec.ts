import type { Page } from '@playwright/test';
import { SESSION_CANCELLED, SESSION_DONE, SESSION_INTERRUPTED, clickNav, expect, test, type App } from './fixtures.js';

async function startCreation(page: Page, app: App, idea = 'A garden planner'): Promise<void> {
  await page.goto(app.url);
  await clickNav(page, 'New project');
  await page.getByLabel('Describe your idea').fill(idea);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('idea')).toHaveText(idea);
}

const panel = (page: Page) => page.getByTestId('agent-panel');
const node = (page: Page, id: string) => page.getByTestId(`agent-${id}`);
/** The text view, one entry per agent ("name · state" and its sentence on one line each). */
const textView = async (page: Page): Promise<string[]> => {
  const toggle = panel(page).getByRole('group', { name: 'Agents view' }).getByRole('button', { name: 'Text' });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const entries = page.getByTestId('panel-text').getByRole('listitem');
  return (await entries.allInnerTexts()).map((entry) => entry.replace(/\s*\n\s*/g, ' ').trim());
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
    const usage = page.getByTestId('panel-usage');
    await expect(usage.getByRole('img', { name: /^12% at the start/ })).toBeVisible();
    await expect(usage.getByRole('img', { name: /^40% at the start/ })).toBeVisible();
    await expect(page.getByTestId('panel-usage')).not.toContainText(/\d\s*tokens|\$|€/i);

    await page.getByRole('button', { name: 'Send answers' }).click();

    // The spec: the architect was refused a write, with the guard's reason, and the target is not shown in full.
    await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
    // The architect's assumptions come inside the summary and are shown with it.
    await expect(page.getByTestId('spec-summary')).toContainText('Assumption: one garden per household.');
    await expect(node(page, 'a1').getByTestId('denial-count')).toHaveText('1 denied');
    await expect(node(page, 'main').getByTestId('node-pending')).toContainText('Asks you to approve the spec');
    await node(page, 'a1').getByRole('button', { name: /architect/ }).click();
    const detail = page.getByTestId('panel-detail');
    await expect(detail).toContainText('Details: architect');
    // The model is on the card; the details add only what the card leaves out (audit M15).
    await expect(node(page, 'a1')).toContainText('opus');
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
    // The request is that same call.
    await expect(page.getByTestId('permission-summary')).toHaveText('briefstack validate');
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
    const before = (await textView(page)).join('\n');
    await page.close();

    // As a user does: the address with the launch token, then the creation in progress.
    const again = await context.newPage();
    await again.goto(app.url);
    await again.getByRole('link', { name: /Creations/ }).click();
    await again.getByTestId('creations').getByRole('link', { name: 'Open' }).click();
    await expect(node(again, 'g1').getByTestId('node-pending')).toBeVisible();
    const entries = await textView(again);
    const after = entries.join('\n');
    // Same lines, apart from running durations.
    const stable = (text: string) => text.replace(/(?:< )?[\d.]+ (?:s|min|h)\b/g, 'N');
    expect(stable(after)).toBe(stable(before));
    expect(after).toContain('generator · Waiting for you');
    expect(after).toContain('2 tool calls');
    expect(entries).toHaveLength(4);
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

test.describe('before the server has said where the creation stands', () => {
  test.use({ appOptions: { recording: 'panel.jsonl' } });

  test('shows Loading, and never an ended state for the main session', async ({ page, app }) => {
    // Every text the main session's state takes, from the first render on, painted or not.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __mainStates: string[] }).__mainStates = seen;
      new MutationObserver(() => {
        const status = document.querySelector('[data-testid="agent-main"] [data-testid="node-status"]');
        const text = status?.textContent ?? undefined;
        if (text !== undefined && seen[seen.length - 1] !== text) seen.push(text);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    // The creation's state answers late (every request for it, also the ones its stream's events
    // trigger); the stream itself does not wait.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/creations\/[0-9a-f-]+$/, async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue();
    });

    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A garden planner');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
    await expect(node(page, 'main')).toHaveCount(0);
    release();

    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Waiting for you');
    const states = await page.evaluate(() => (window as unknown as { __mainStates: string[] }).__mainStates);
    for (const ended of ['Interrupted', 'Done', 'Failed', 'Cancelled', 'No end recorded']) expect(states, states.join(' → ')).not.toContain(ended);
  });
});

test.describe('finished sessions', () => {
  test('a cancelled and an interrupted session open their panel from the projects page', async ({ page, app }) => {
    await page.goto(app.url);
    const unfinished = page.getByTestId('unfinished');
    // Each card's title links its idea; the card is found by the session id beside it.
    await unfinished.getByRole('listitem').filter({ hasText: SESSION_CANCELLED }).getByRole('heading').getByRole('link').click();
    await expect(page.getByTestId('session-status')).toContainText('Cancelled');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Cancelled');
    await expect(page.getByTestId('progress').locator('li[data-state="running"]')).toHaveCount(1);

    await page.goBack();
    await page.getByTestId('unfinished').getByRole('listitem').filter({ hasText: SESSION_INTERRUPTED }).getByRole('heading').getByRole('link').click();
    await expect(page.getByTestId('session-status')).toContainText('Interrupted');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Interrupted');
    // Only "research" was recorded: the steps before it were passed, and research is where it was cut,
    // not a step that waits for the user.
    const segment = (name: string) => page.getByTestId('progress').getByRole('listitem').filter({ hasText: name });
    for (const name of ['Idea', 'Gap analysis', 'Interview']) await expect(segment(name)).toContainText('passed');
    await expect(segment('Research')).toContainText('interrupted here');
    await expect(segment('Research')).not.toHaveAttribute('aria-current', 'step');
    await expect(segment('Spec')).toContainText('waiting');
  });

  test('numbers an agent type that ran twice, as in the real H10 run', async ({ page, app }) => {
    const { cp } = await import('node:fs/promises');
    const { PACKAGE_ROOT } = await import('../../src/packageRoot.js');
    const path = await import('node:path');
    await cp(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'sessions', 'h10-run3.jsonl'), path.join(app.sessionsDir, 'h10-run3-session', 'events.jsonl'));
    await page.goto(app.url);
    await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
    await page.evaluate(() => (window.location.hash = '#/sessions/h10-run3-session'));
    await expect(page.getByTestId('session-status')).toContainText('Completed');
    await expect(node(page, 'agent-1')).toContainText('interviewer · 1');
    await expect(node(page, 'agent-2')).toContainText('interviewer · 2');
    await expect(node(page, 'agent-4')).toContainText('architect');
    await expect(node(page, 'agent-4')).not.toContainText('architect ·');
  });

  test('a session recorded before phase 3 still renders, from the project page', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Garden planner' }).click();
    await page.getByTestId('open-panel').click();
    await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_DONE}$`));
    await expect(page.getByTestId('session-status')).toContainText('Completed');
    await expect(node(page, 'main').getByTestId('node-status')).toHaveText('Done');
    await expect(page.getByTestId('panel-detail')).toContainText('Details: Main session');
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
    // Not just the architect's node: it starts a moment before the spec approval reaches the main session.
    await expect(node(page, 'main').getByTestId('node-pending')).toContainText('Asks you to approve the spec');
    const text = (await textView(page)).join('\n');
    expect(text).toContain('Main session · Waiting for you');
    expect(text).toContain('interviewer · Done');
    expect(text).toContain('architect · Done');
    expect(text).toContain('1 denied');

    // Back to the tree, where the timeline is.
    await panel(page).getByRole('group', { name: 'Agents view' }).getByRole('button', { name: 'Tree' }).click();
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

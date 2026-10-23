import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { SESSION_INTERRUPTED, clickNav, expect, recordProject, test } from '../e2e/fixtures.js';

// The creation screen and a finished session's panel, at desktop and phone
// width, in both themes (U5). Output: `screenshots/u5/`, git-ignored.
const OUT = path.join(PACKAGE_ROOT, 'screenshots', 'u5');
const VIEWS = [
  { name: 'desktop-dark', width: 1280, height: 900, scheme: 'dark' },
  { name: 'desktop-light', width: 1280, height: 900, scheme: 'light' },
  { name: 'narrow-dark', width: 390, height: 844, scheme: 'dark' },
  { name: 'narrow-light', width: 390, height: 844, scheme: 'light' },
] as const;

// A full-page picture stitches the page: what stays in place while scrolling (the creation's head, the
// rail, the phone's top bar) would land in the middle. For the picture only, they scroll with the page.
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true, style: '.sticky, .rail, .topbar { position: static !important; } .rail { height: auto !important; align-self: stretch !important; }' });
};

for (const size of VIEWS) {
  test.describe(`panel at ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      colorScheme: size.scheme,
      appOptions: { recording: 'panel.jsonl', planUsage: [{ fiveHour: 12, sevenDay: 40 }, { fiveHour: 15, sevenDay: 41 }] },
    });

    test('live creation, the spec, the permission, the result', async ({ page, app }) => {
      await page.goto(app.url);
      await clickNav(page, 'New project');
      await page.getByLabel('Describe your idea').fill('A garden planner for my family, with a planting calendar.');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      await expect(page.getByTestId('node-pending')).toBeVisible();
      await shot(page, `${size.name}-1-question`);
      await page.getByRole('button', { name: 'Send answers' }).click();
      await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
      await page.getByTestId('agent-a1').getByRole('button', { name: /architect/ }).click();
      await shot(page, `${size.name}-2-spec-denial`);
      await page.getByRole('button', { name: 'Request changes' }).click();
      await page.getByLabel('What should change?').fill('Add a watering reminder.');
      await shot(page, `${size.name}-2b-spec-changes`);
      await page.getByRole('button', { name: 'Back' }).click();
      // The project the learn step records, so the result has a folder, a command and next steps.
      const session = app.manager.list()[0]?.sessionId ?? 'unknown';
      await recordProject(app, 'garden-planner', 'Garden planner', session, {
        target: 'claude-app',
        nextSteps: '# Next steps\n\n1. Open the Claude app.\n2. Create a project and paste INSTRUCTIONS.md.\n3. Ask for this week’s planting list.\n',
      });
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByTestId('agent-g1').getByTestId('node-pending')).toBeVisible();
      await shot(page, `${size.name}-3-permission`);
      await page.getByRole('group', { name: 'Agents view' }).getByRole('button', { name: 'Text' }).click();
      await shot(page, `${size.name}-3b-text-view`);
      await page.getByRole('button', { name: 'Allow' }).click();
      await expect(page.getByTestId('result')).toBeVisible();
      await expect(page.getByTestId('agent-main').getByTestId('node-status')).toHaveText('Done');
      await expect(page.getByTestId('open-command')).toBeVisible();
      await shot(page, `${size.name}-4-result`);
    });

    test.describe('a run that leaves three suggestions', () => {
      // A guard denial, a turn that ends with a question in plain text and two review rounds: three
      // suggestions, the most the flow makes per creation.
      test.use({
        appOptions: {
          planUsage: [{ fiveHour: 20, sevenDay: 44 }],
          recordingText: [
            '{"do":"session","phase":"started"}',
            '{"do":"flow","step":"idea","phase":"started"}',
            '{"do":"flow","step":"idea","phase":"finished","outcome":"ok"}',
            '{"do":"flow","step":"spec","phase":"started"}',
            '{"do":"hook","type":"subagent.start","agentId":"a1","agentType":"architect","model":"opus"}',
            '{"do":"hook","type":"tool.pre","agentId":"a1","agentType":"architect","tool":"Write","toolUseId":"a1w1","target":{"root":"outside"}}',
            '{"do":"emit","event":{"kind":"denial","toolName":"Write","summary":"write","agentType":"architect","agentId":"a1","toolUseId":"a1w1","reason":"Writes are only allowed inside the projects folder."}}',
            '{"do":"hook","type":"subagent.stop","agentId":"a1","agentType":"architect"}',
            '{"do":"turnEnd","message":"Which **name** do you want for the project?"}',
            '{"do":"flow","step":"spec","phase":"finished","outcome":"ok"}',
            '{"do":"flow","step":"validate-review","phase":"started"}',
            '{"do":"hook","type":"subagent.start","agentId":"r1","agentType":"reviewer","model":"opus"}',
            '{"do":"hook","type":"subagent.stop","agentId":"r1","agentType":"reviewer"}',
            '{"do":"hook","type":"subagent.start","agentId":"r2","agentType":"reviewer","model":"opus"}',
            '{"do":"hook","type":"subagent.stop","agentId":"r2","agentType":"reviewer"}',
            '{"do":"flow","step":"validate-review","phase":"finished","outcome":"ok"}',
            '{"do":"session","phase":"finished","outcome":"completed"}',
          ].join('\n'),
        },
      });

      test('the free-text reply, the bar that stays on a phone, and the suggestions', async ({ page, app }) => {
      await page.goto(app.url);
      await clickNav(page, 'New project');
      await page.getByLabel('Describe your idea').fill('A recipe box for the family, with a weekly shopping list.');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByTestId('awaiting-reply')).toBeVisible();
      await expect(page.getByTestId('agent-a1')).toBeVisible();
      await shot(page, `${size.name}-7-reply`);
      // What stays in sight once the page scrolls: on a phone, only the compact bar.
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.screenshot({ path: path.join(OUT, `${size.name}-7b-scrolled.png`) });
      await page.getByLabel('Your reply').fill('Call it Recipe box.');
      await page.getByRole('button', { name: 'Send reply' }).click();
      await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed');
      await expect(page.getByTestId('creation-suggestions')).toBeVisible();
      await expect(page.getByTestId('creation-suggestions').getByRole('listitem')).toHaveCount(3);
      await shot(page, `${size.name}-8-suggestions`);
      });
    });

    test('a finished session from the real H10 run and an interrupted one', async ({ page, app }) => {
      const { cp } = await import('node:fs/promises');
      await cp(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'sessions', 'h10-run3.jsonl'), path.join(app.sessionsDir, 'h10-run3-session', 'events.jsonl'));
      await page.goto(app.url);
      await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
      await page.evaluate(() => (window.location.hash = '#/sessions/h10-run3-session'));
      await expect(page.getByTestId('session-status')).toContainText('Completed');
      await shot(page, `${size.name}-5-h10-run3`);
      await page.evaluate((id) => (window.location.hash = `#/sessions/${id}`), SESSION_INTERRUPTED);
      await expect(page.getByTestId('session-status')).toContainText('Interrupted');
      await shot(page, `${size.name}-6-interrupted`);
    });
  });
}

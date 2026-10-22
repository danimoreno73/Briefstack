import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { expect, test } from '../e2e/fixtures.js';

// Every screen of the web app over the fake runners, at 1280 and 390 px, in
// the light and the dark scheme, for the UI audit (BRIEF-ui §6, U0 and U4).
// Not part of the test suite. `SHOTS_OUT` names the folder, relative to the
// repo (default `screenshots/audit`, which git ignores). The theme follows
// the scheme of each run (the switch stays on System).
// Run: `npm run screenshots -- audit.shots.ts`.

const OUT = path.join(PACKAGE_ROOT, ...(process.env.SHOTS_OUT ?? 'screenshots/audit').split('/'));
/** Only these screen numbers, comma separated (`01,05`); all by default. */
const ONLY = process.env.SHOTS_ONLY?.split(',');
/** Only these views, comma separated (`1280-light,1280-dark,390-light`); all four by default. */
const VIEWS = process.env.SHOTS_VIEWS?.split(',');

const SIZES = [
  { name: '1280', width: 1280, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

const PANEL_USAGE = [
  { fiveHour: 12, sevenDay: 40 },
  { fiveHour: 15, sevenDay: 41 },
];

const AWAITING_REPLY = [
  '{"do":"session","phase":"started"}',
  '{"do":"flow","step":"interview","phase":"started"}',
  '{"do":"turnEnd","message":"Which **name** do you want for the project? I can suggest a few if you tell me who will use it."}',
  '{"do":"wait","ms":60000}',
].join('\n');

const FLAGGED_ROUND = {
  edits: [{ file: '.claude/agents/interviewer.md', find: 'Rules:', replace: 'When unsure, you may ask in plain text.\n\nRules:' }],
  submission: {
    title: 'Faster interviews',
    expectedEffect: 'Fewer form questions.',
    changes: [{ file: '.claude/agents/interviewer.md', rationale: 'Forms felt slow.', evidence: ['request.md'] }],
  },
};

const wanted = (name: string) => ONLY === undefined || ONLY.some((prefix) => name.startsWith(prefix));

/** The test's temp folder, shown as `<tmp>` so no path from this machine lands in a committed picture. */
let tempDir = '';

async function hideTempDir(page: Page): Promise<void> {
  const variants = [tempDir, tempDir.replaceAll('\\', '/')];
  await page.evaluate((prefixes) => {
    const swap = (text: string) => prefixes.reduce((out, prefix) => out.split(prefix).join('<tmp>'), text);
    // A path is cut into one text node per folder (`PathText`), so it is swapped whole and cut again.
    for (const element of document.querySelectorAll<HTMLElement>('.path-text')) {
      const text = element.textContent ?? '';
      if (!prefixes.some((prefix) => text.includes(prefix))) continue;
      const pieces = swap(text).split(/(?<=[\\/])/);
      element.replaceChildren(...pieces.flatMap((piece, index) => (index === 0 ? [piece] : [document.createElement('wbr'), piece])));
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue !== null && prefixes.some((prefix) => node.nodeValue?.includes(prefix))) node.nodeValue = swap(node.nodeValue);
    }
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      if (prefixes.some((prefix) => field.value.includes(prefix))) field.value = swap(field.value);
    }
  }, variants);
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    if (VIEWS !== undefined && !VIEWS.includes(`${size.name}-${scheme}`)) continue;
    const folder = path.join(OUT, `${size.name}-${scheme}`);
    const shot = async (page: Page, name: string) => {
      if (!wanted(name)) return;
      // Let fonts, focus rings and the panel's 200 ms recompute settle.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await hideTempDir(page);
      await page.screenshot({ path: path.join(folder, `${name}.jpg`), fullPage: true, type: 'jpeg', quality: 80 });
    };

    test.describe(`${size.name} px, ${scheme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme });
      test.beforeEach(({ app }) => {
        tempDir = app.dir;
      });

      test.describe('projects, a project, a past session, the gate', () => {
        test('screens', async ({ page, app }) => {
          await cp(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'sessions', 'h10-run3.jsonl'), path.join(app.sessionsDir, 'h10-run3-session', 'events.jsonl'));
          await page.goto(app.url);
          await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
          await expect(page.getByTestId('unfinished')).toBeVisible();
          await shot(page, '01-projects');
          await page.getByRole('link', { name: 'Garden planner' }).click();
          await expect(page.getByTestId('status')).toBeVisible();
          await shot(page, '02-project');
          await page.evaluate(() => (window.location.hash = '#/sessions/h10-run3-session'));
          await expect(page.getByTestId('session-status')).toContainText('Completed');
          await shot(page, '03-session-finished');
          // After a restart the old tab's token is refused (backlog item in BRIEF-ui §4).
          await page.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"web.rejected.token"}' }));
          await page.getByRole('link', { name: 'Library' }).click();
          await expect(page.getByRole('heading', { name: 'briefstack was restarted' })).toBeVisible();
          await shot(page, '24-old-tab-401');
          await page.unroute('**/api/**');
          await page.evaluate(() => sessionStorage.clear());
          await page.goto(new URL(app.url).origin);
          await expect(page.getByRole('status')).toBeVisible();
          await shot(page, '25-no-token');
        });
      });

      test.describe('the creation flow', () => {
        test.use({ appOptions: { recording: 'panel.jsonl', planUsage: PANEL_USAGE } });
        test('screens', async ({ page, app }) => {
          await page.goto(app.url);
          await page.getByRole('link', { name: 'New project' }).click();
          await page.getByLabel('Describe your idea').fill('A garden planner for my family, with a planting calendar.');
          await shot(page, '04-new-project');
          await page.getByRole('button', { name: 'Start' }).click();
          await expect(page.getByTestId('agent-panel')).toBeVisible();
          await expect(page.getByTestId('node-pending')).toBeVisible();
          await shot(page, '05-creation-question');
          await page.getByRole('button', { name: 'Send answers' }).click();
          await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible();
          await shot(page, '06-creation-spec');
          await page.getByRole('button', { name: 'Approve' }).click();
          await expect(page.getByTestId('agent-g1').getByTestId('node-pending')).toBeVisible();
          await shot(page, '07-creation-permission');
          await page.getByRole('button', { name: 'Allow' }).click();
          await expect(page.getByTestId('result')).toBeVisible();
          await expect(page.getByTestId('agent-main').getByTestId('node-status')).toHaveText('Done');
          await shot(page, '08-creation-result');
        });
      });

      test.describe('a creation waiting for a free-text reply', () => {
        test.use({ appOptions: { recordingText: AWAITING_REPLY } });
        test('screens', async ({ page, app }) => {
          await page.goto(app.url);
          await page.getByRole('link', { name: 'New project' }).click();
          await page.getByLabel('Describe your idea').fill('A garden planner for my family.');
          await page.getByRole('button', { name: 'Start' }).click();
          await expect(page.getByTestId('awaiting-reply')).toBeVisible();
          await shot(page, '09-creation-reply');
        });
      });

      test.describe('two running creations', () => {
        test.use({ appOptions: { recording: 'working.jsonl' } });
        test('screens', async ({ page, app }) => {
          await app.manager.create('A recipe box for the family, sorted by season');
          const second = await app.manager.create('A reading tracker for a book club of six people');
          await page.goto(app.url);
          await page.getByRole('link', { name: /Creations/ }).click();
          await expect(page.getByTestId('creations')).toBeVisible();
          await shot(page, '10-creations');
          await page.getByRole('link', { name: 'New project' }).click();
          await expect(page.getByTestId('usage-adds-up')).toBeVisible();
          await shot(page, '11-new-project-busy');
          await page.evaluate((id) => (window.location.hash = `#/new/${id}`), second.id);
          await expect(page.getByTestId('working')).toBeVisible();
          await page.getByRole('button', { name: 'Cancel creation' }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await shot(page, '12-cancel-dialog');
        });
      });

      test.describe('the library', () => {
        test('screens', async ({ page, app }) => {
          await page.goto(app.url);
          await page.getByRole('link', { name: 'Library' }).click();
          await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
          await shot(page, '13-library-index');
          await page.getByRole('link', { name: 'Profile' }).click();
          await expect(page.getByTestId('notes')).toBeVisible();
          await shot(page, '14-library-notes');
          await page.getByTestId('notes').getByRole('link', { name: 'style' }).click();
          await expect(page.getByTestId('editor')).toBeVisible();
          await page.getByTestId('editor').fill('# Style\n\nShort answers.\n\n- Use metric units.\n- Prefer plain words.\n');
          await shot(page, '15-library-editor');
          await page.getByRole('link', { name: 'History' }).click();
          await expect(page.getByTestId('history')).toBeVisible();
          await shot(page, '16-library-history');
          await page.getByTestId('history').getByRole('button', { name: 'Revert' }).first().click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await shot(page, '17-revert-dialog');
        });
      });

      test.describe('usage and settings', () => {
        test('screens', async ({ page, app }) => {
          await page.goto(app.url);
          await page.getByRole('link', { name: 'Usage' }).click();
          await expect(page.getByTestId('active-profile')).toBeVisible();
          await shot(page, '18-usage');
          await page.getByRole('link', { name: 'Settings' }).click();
          await expect(page.getByTestId('paths')).toBeVisible();
          await shot(page, '19-settings');
        });
      });

      test.describe('the chat', () => {
        test.use({
          appOptions: {
            chatScript: {
              turns: [
                [{ call: 'list_projects' }, { say: 'You have one project: **Garden planner**, a Claude app project created on 12 October.' }],
                [{ call: 'propose_note_change', args: { section: 'profile', name: 'style', text: '# Style\n\nShort answers.\nUse metric units.\n' } }, { say: 'Saved.' }],
              ],
            },
          },
        });
        test('screens', async ({ page, app }) => {
          await page.goto(app.url);
          await page.getByRole('button', { name: 'Open the chat' }).click();
          await expect(page.getByTestId('chat-drawer')).toBeVisible();
          await shot(page, '20-chat-drawer');
          // At phone width the drawer covers the menu.
          await page.getByRole('button', { name: 'Close the chat' }).click();
          await page.getByRole('link', { name: 'Chat' }).first().click();
          await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeVisible();
          const panel = page.getByTestId('chat-panel');
          await panel.getByLabel('Your message').fill('Which projects do I have?');
          await panel.getByRole('button', { name: 'Send' }).click();
          await expect(panel.locator('[data-role="assistant"]')).toContainText('Garden planner');
          await panel.getByLabel('Your message').fill('Remember that I use metric units.');
          await panel.getByRole('button', { name: 'Send' }).click();
          await expect(page.getByTestId('chat-card').last()).toHaveAttribute('data-state', 'pending');
          await shot(page, '21-chat-card');
        });
      });

      test.describe('improvements', () => {
        test.use({ appOptions: { improveScript: { rounds: [FLAGGED_ROUND] } } });
        test('screens', async ({ page, app }) => {
          await app.improvements.prepare('Faster interviews.');
          await page.goto(app.url);
          await page.getByRole('link', { name: 'Improvements' }).first().click();
          await expect(page.getByTestId('proposals')).toBeVisible();
          await expect(page.getByTestId('proposals').getByTestId('proposal-row-status')).toHaveText('Ready to review');
          await shot(page, '22-improvements');
          await page.getByTestId('proposals').getByRole('link', { name: 'Open' }).click();
          await expect(page.getByTestId('safety-warning')).toBeVisible();
          await shot(page, '23-proposal');
        });
      });

      test.describe('in Spanish', () => {
        test.use({ appOptions: { lang: 'es', recording: 'panel.jsonl', planUsage: PANEL_USAGE } });
        test('screens', async ({ page, app }) => {
          await page.goto(app.url);
          await expect(page.getByRole('link', { name: 'Garden planner' })).toBeVisible();
          await shot(page, '26-es-projects');
          await page.getByRole('link', { name: 'Proyecto nuevo' }).click();
          await page.getByRole('textbox').first().fill('Un planificador de huerto para mi familia.');
          await page.getByRole('button', { name: 'Empezar' }).click();
          await expect(page.getByTestId('node-pending')).toBeVisible();
          await shot(page, '27-es-creation-question');
        });
      });
    });
  }
}

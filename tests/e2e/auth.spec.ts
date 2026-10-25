import type { Page } from '@playwright/test';
import { clickNav, expect, test, type App } from './fixtures.js';

// How the user's Claude Code signs in (BRIEF-release §2, §4): the Settings
// card says which mode is in use, the plan usage only shows with a Claude
// plan, and the web says what to do when Claude Code cannot create a project.
// The fake runner stands in for Claude Code; the server reports the mode the
// test sets, as it would from Claude Code's own answer.

const COMPATIBLE = { status: 'compatible', installed: '2.1.310', expected: '2.1.286' } as const;

async function startCreation(page: Page, app: App): Promise<void> {
  await page.goto(app.url);
  await clickNav(page, 'New project');
  await page.getByLabel('Describe your idea').fill('A garden planner');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('idea')).toHaveText('A garden planner');
}

const claudeCard = (page: Page) => page.getByTestId('claude-card');

test.describe('signed in with a Claude plan', () => {
  test.use({ appOptions: { recording: 'panel.jsonl', planUsage: [{ fiveHour: 12, sevenDay: 40 }] } });

  test('Settings names the plan, no banner shows, and the panel shows the plan usage', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByTestId('claude-banner')).toHaveCount(0);
    await clickNav(page, 'Settings');
    await expect(claudeCard(page).getByTestId('claude-mode')).toHaveText("Claude plan (Claude Pro): creations use your plan's limits.");
    await expect(claudeCard(page)).toContainText('2.1.310 (briefstack was built for 2.1.286)');
    await startCreation(page, app);
    await expect(page.getByTestId('panel-usage').getByRole('img', { name: /^12% at the start/ })).toBeVisible();
  });
});

test.describe('an API key', () => {
  test.use({
    appOptions: {
      recording: 'panel.jsonl',
      planUsage: [{ fiveHour: 12, sevenDay: 40 }],
      claude: { install: COMPATIBLE, mode: { kind: 'apiKey', source: 'environment' } },
    },
  });

  test('Settings says API key and where it comes from, and the panel hides the plan usage and says why', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByTestId('claude-banner')).toHaveCount(0);
    await clickNav(page, 'Settings');
    await expect(claudeCard(page).getByTestId('claude-mode')).toHaveText('API key (ANTHROPIC_API_KEY): creations are billed per use to that key.');
    await startCreation(page, app);
    const usage = page.getByTestId('panel-usage');
    await expect(usage).toHaveAttribute('data-hidden', 'true');
    await expect(usage).toContainText('Not shown: Claude Code uses an API key, billed per use');
    await expect(usage.getByRole('img')).toHaveCount(0);
  });
});

test.describe('a cloud provider', () => {
  test.use({ appOptions: { recording: 'panel.jsonl', claude: { install: COMPATIBLE, mode: { kind: 'cloud', provider: 'bedrock' } } } });

  test('Settings names the provider, and the panel hides the plan usage', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Settings');
    await expect(claudeCard(page).getByTestId('claude-mode')).toHaveText('Cloud provider (bedrock): creations are billed by that provider.');
    await startCreation(page, app);
    await expect(page.getByTestId('panel-usage')).toContainText('Not shown: Claude Code uses a cloud provider');
  });
});

test.describe('not signed in', () => {
  test.use({ appOptions: { claude: { install: COMPATIBLE, mode: { kind: 'none' } } } });

  test('a banner on every page leads to Settings, which says exactly what to do', async ({ page, app }) => {
    await page.goto(app.url);
    const banner = page.getByTestId('claude-banner');
    await expect(banner).toContainText('Claude Code needs your attention before a project can be created.');
    await clickNav(page, 'New project');
    await expect(banner).toBeVisible();
    await banner.getByRole('link', { name: 'See what to do' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByTestId('claude-banner')).toHaveCount(0);
    await expect(claudeCard(page).getByTestId('claude-mode-problem')).toContainText('Run `claude` in a terminal and sign in with your Claude account, or set ANTHROPIC_API_KEY');
  });
});

test.describe('Claude Code missing', () => {
  test.use({ appOptions: { claude: { install: { status: 'notFound' }, mode: { kind: 'unknown' } } } });

  test('the banner shows, and Settings says how to install it', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByTestId('claude-banner')).toBeVisible();
    await clickNav(page, 'Settings');
    await expect(claudeCard(page).getByTestId('claude-problem')).toContainText('Claude Code was not found');
    await expect(claudeCard(page).getByTestId('claude-problem')).toContainText('https://code.claude.com/docs/en/setup');
    await expect(claudeCard(page).getByTestId('claude-facts')).toHaveCount(0);
  });
});

test.describe('Claude Code too old', () => {
  test.use({ appOptions: { claude: { install: { status: 'older', installed: '2.1.200', expected: '2.1.286' }, mode: { kind: 'signIn' } } } });

  test('Settings says to update it, and the check can be run again', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByTestId('claude-banner')).toBeVisible();
    await clickNav(page, 'Settings');
    await expect(claudeCard(page).getByTestId('claude-problem')).toContainText('Update it with `claude update`');
    await claudeCard(page).getByRole('button', { name: 'Check again' }).click();
    await expect(claudeCard(page).getByRole('button', { name: 'Check again' })).toBeEnabled();
  });
});

test.describe('in Spanish', () => {
  test.use({ appOptions: { lang: 'es', claude: { install: COMPATIBLE, mode: { kind: 'apiKey', source: 'environment' } } } });

  test('Ajustes dice el modo en español', async ({ page, app }) => {
    await page.goto(app.url);
    await page.locator('nav#rail').getByRole('link', { name: 'Ajustes', exact: true }).click();
    await expect(claudeCard(page).getByTestId('claude-mode')).toHaveText('Clave de API (ANTHROPIC_API_KEY): las creaciones se cobran por uso a esa clave.');
  });
});

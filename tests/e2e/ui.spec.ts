import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { FAKE_KEY, clickNav, expect, test } from './fixtures.js';

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** The page as a reader sees it: visible text plus every attribute. Textarea values are in neither. */
async function everywhere(page: Page): Promise<string> {
  return page.evaluate(() => `${document.body.innerText}\n${document.documentElement.outerHTML}`);
}

test.describe('start-up', () => {
  test('keeps the token out of the address and survives a reload (F5)', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    expect(page.url()).not.toContain('token');
    expect(page.url()).not.toContain('#token');

    await page.getByRole('link', { name: 'Library' }).click();
    await expect(page.getByRole('heading', { name: 'Personal library' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Personal library' })).toBeVisible();
    expect(page.url()).toContain('#/library');
    expect(page.url()).not.toContain('token');

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  test('switches the theme and keeps it after a reload, then follows the system again', async ({ page, app }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(app.url);
    const theme = page.getByRole('button', { name: /^Theme:/ });
    await expect(theme).toHaveAccessibleName('Theme: System');
    // bs.css changes only through the attribute: under "System" it holds the system's theme, and follows it.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await theme.click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.getByRole('menu', { name: 'Theme' })).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // The page's ground is painted on <html class="bs">.
    const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    const dark = await background();
    await page.reload();
    await expect(theme).toHaveAccessibleName('Theme: Dark');
    await expect.poll(background).toBe(dark);

    await theme.click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(background).not.toBe(dark);
    await page.reload();
    await expect(theme).toHaveAccessibleName('Theme: System');
  });

  test('the theme menu works with the keyboard and shows where the focus is', async ({ page, app }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(app.url);
    const theme = page.getByRole('button', { name: /^Theme:/ });
    const menu = page.getByRole('menu', { name: 'Theme' });
    const item = (name: string) => page.getByRole('menuitemradio', { name });
    const outline = (locator: ReturnType<typeof item>) => locator.evaluate((element) => getComputedStyle(element).outlineStyle);
    await expect(theme).toHaveAttribute('aria-expanded', 'false');

    // The arrows open it on the current choice; Escape closes it with nothing changed.
    await theme.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await expect(theme).toHaveAttribute('aria-expanded', 'true');
    await expect(item('System')).toBeFocused();
    await expect(item('System')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => outline(item('System'))).toBe('solid');
    await page.keyboard.press('ArrowDown');
    await expect(item('Light')).toBeFocused();
    await expect(item('System')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(theme).toBeFocused();
    await expect.poll(() => outline(theme)).toBe('solid');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Enter opens it; End, Home and wrapping arrows move; Enter chooses and gives the focus back.
    await page.keyboard.press('Enter');
    await expect(item('System')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item('Dark')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item('System')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('Dark')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(theme).toBeFocused();
    await expect(theme).toHaveAccessibleName('Theme: Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Space chooses too.
    await page.keyboard.press('ArrowUp');
    await expect(item('Dark')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press(' ');
    await expect(theme).toHaveAccessibleName('Theme: Light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Tab leaves it, and a click elsewhere closes it; neither changes the theme.
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();
    await theme.click();
    await expect(menu).toBeVisible();
    await page.getByRole('heading', { name: 'Projects' }).click();
    await expect(menu).toBeHidden();
    await expect(theme).toHaveAccessibleName('Theme: Light');
  });

  test('on a phone, Escape in the theme menu closes only that menu', async ({ page, app }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(app.url);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    // Opening the rail moves focus to its close button; wait for that before
    // focusing the theme button, or the move lands after it and takes focus away.
    await expect(page.getByRole('button', { name: 'Close the menu' })).toBeFocused();
    const theme = page.getByRole('button', { name: /^Theme:/ });
    await theme.focus();
    await expect(theme).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'Theme' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Theme' })).toBeHidden();
    await expect(theme).toBeFocused();
    await expect(page.getByRole('button', { name: 'Close the menu' })).toBeVisible();
    // A second Escape closes the rail, as before.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Close the menu' })).toBeHidden();
  });

  test('an old tab after a restart says to open the new link, with no retry', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    // The server now has another token: every request of this tab is refused.
    await page.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"web.rejected.token"}' }));
    // A move to another page sends requests. Not a click on the menu: the menu's own periodic check may
    // already have been refused and turned the page into the message, taking the link with it.
    await page.evaluate(() => {
      window.location.hash = '#/library';
    });
    await expect(page.getByRole('heading', { name: 'briefstack was restarted' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Open the new link from the terminal.');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('names each page in the tab title, and skips to the content from the keyboard', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page).toHaveTitle('Projects · briefstack');
    await page.getByRole('link', { name: 'Garden planner' }).click();
    await expect(page).toHaveTitle('Garden planner · briefstack');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveTitle('Settings · briefstack');

    // The skip link is the first stop of a freshly loaded page.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    expect(page.url()).toContain('#/settings');
  });

  test('says what to do when opened without the token', async ({ page, app }) => {
    await page.goto(new URL(app.url).origin + '/');
    await expect(page.getByRole('status')).toContainText('Open the address that briefstack web printed');
  });
});

test.describe('projects', () => {
  test('lists projects and sets interrupted and cancelled creations apart', async ({ page, app }) => {
    await page.goto(app.url);
    const row = page.getByTestId('projects').getByRole('row', { name: /Garden planner/ });
    await expect(row).toContainText('claude-app');
    await expect(row).toContainText('created');
    await expect(row).toContainText('2026-10-12');
    await expect(row).toContainText('garden planner');

    const unfinished = page.getByTestId('unfinished');
    await expect(unfinished).toContainText('sess-cancelled');
    const cancelled = unfinished.getByRole('listitem').filter({ hasText: 'sess-cancelled' });
    await expect(cancelled).toContainText('Interview');
    // Named by its idea, redacted, and the idea opens the session.
    await expect(cancelled.getByRole('link', { name: 'A reading log for my book club. [redacted]' })).toBeVisible();
    await expect(unfinished).not.toContainText(FAKE_KEY);
    await expect(unfinished).toContainText('sess-interrupted');
    const interrupted = unfinished.getByRole('listitem').filter({ hasText: 'sess-interrupted' });
    await expect(interrupted).toContainText('Research');
    await expect(interrupted.getByRole('link', { name: 'Idea not recorded' })).toBeVisible();
    // With no idea recorded there is nothing to start again from.
    await expect(interrupted.getByRole('button', { name: 'Start again with this idea' })).toHaveCount(0);
    await expect(unfinished).not.toContainText('sess-done');
  });

  test('starts again from an unfinished idea: New project opens with it written, nothing starts by itself', async ({ page, app }) => {
    await page.goto(app.url);
    const cancelled = page.getByTestId('unfinished').getByRole('listitem').filter({ hasText: 'sess-cancelled' });
    await cancelled.getByRole('button', { name: 'Start again with this idea' }).click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByLabel('Describe your idea')).toHaveValue('A reading log for my book club. [redacted]');
    expect(app.manager.list()).toHaveLength(0);
    // Only once: the next visit starts with an empty box.
    await clickNav(page, 'Projects');
    await clickNav(page, 'New project');
    await expect(page.getByLabel('Describe your idea')).toHaveValue('');
  });

  test('shows the detail, the history, the next steps and the copy buttons', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Garden planner' }).click();
    await expect(page.getByRole('heading', { name: 'Garden planner', level: 1 })).toBeVisible();
    await expect(page.getByText('A garden planner.')).toBeVisible();
    await expect(page.getByTestId('target-chosen-by')).toHaveText('you');
    await expect(page.getByText('Mostly conversation about the garden.')).toBeVisible();

    const timeline = page.getByTestId('timeline');
    await expect(timeline).toContainText('Interview');
    await expect(timeline).toContainText('done');
    await expect(page.getByRole('heading', { name: 'Next steps', level: 2 })).toBeVisible();
    await expect(page.getByText('Open the Claude app.')).toBeVisible();

    await page.getByTestId('copy-path').click();
    await expect(page.getByTestId('copy-path')).toHaveText('Copied');
    expect(path.normalize(await readClipboard(page))).toBe(path.normalize(app.gardenDir));

    await page.getByTestId('copy-instructions').click();
    expect(await readClipboard(page)).toContain('Be brief.');
  });

  test('puts the path in quotes in the command to open it in Claude Code', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Garden planner' }).click();
    const command = page.getByTestId('open-command');
    const [cd, run] = (await command.innerText()).split('\n');
    expect(cd).toMatch(/^cd ".*garden planner"$/);
    expect(path.normalize((cd ?? '').slice(4, -1))).toBe(path.normalize(app.gardenDir));
    expect(run).toBe('claude');
    await page.getByTestId('copy-command').click();
    expect((await readClipboard(page)).split(/\r?\n/).map((line) => line.trim())).toEqual([cd, run]);
  });
});

test.describe('library', () => {
  test('edits a note with a live preview and saves it as one commit', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Profile' }).click();
    await page.getByRole('link', { name: 'style' }).click();

    const editor = page.getByTestId('editor');
    await expect(editor).toHaveValue(/Short answers\./);
    const save = page.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await editor.fill('# Style\n\nLonger answers, with **examples**.\n');
    await expect(page.getByTestId('preview').locator('strong')).toHaveText('examples');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole('status')).toContainText('Saved.');
    expect(await readFile(path.join(app.libraryDir, 'profile', 'style.md'), 'utf8')).toContain('Longer answers');

    await page.getByRole('link', { name: 'History' }).click();
    await expect(page.getByTestId('history').getByRole('listitem').first()).toContainText('profile/style');
  });

  test('refuses to save a secret: the editor is marked, nothing is written, typing clears the mark', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Profile' }).click();
    await page.getByRole('link', { name: 'style' }).click();
    const editor = page.getByTestId('editor');
    await expect(editor).toHaveValue(/Short answers\./);
    await editor.fill(`# Style\n\nkey: ${FAKE_KEY}\n`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('secret');
    await expect(editor).toHaveAttribute('aria-invalid', 'true');
    expect(await readFile(path.join(app.libraryDir, 'profile', 'style.md'), 'utf8')).not.toContain(FAKE_KEY);
    await editor.fill('# Style\n\nShort answers.\n');
    await expect(editor).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('does not render raw HTML from a note', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Profile' }).click();
    await page.getByRole('link', { name: 'style' }).click();
    await page.getByTestId('editor').fill('# Style\n\n<img src=x onerror="document.title=\'pwned\'">\n');
    await expect(page.getByTestId('preview')).toContainText('<img');
    await expect(page.getByTestId('preview').locator('img')).toHaveCount(0);
    await expect(page).toHaveTitle('style · briefstack');
  });

  test('asks for confirmation before reverting a commit, and reverts only after it', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Profile' }).click();
    await page.getByRole('link', { name: 'style' }).click();
    await page.getByTestId('editor').fill('# Style\n\nLonger answers.\n');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved.');
    const styleFile = path.join(app.libraryDir, 'profile', 'style.md');
    expect(await readFile(styleFile, 'utf8')).toContain('Longer answers');

    await page.getByRole('link', { name: 'History' }).click();
    const history = page.getByTestId('history');
    const items = history.getByRole('listitem');
    await expect(items.first()).toBeVisible();
    const before = await items.count();
    await items.first().getByRole('button', { name: 'Revert' }).click();

    // Nothing happens until the dialog is confirmed.
    const dialog = page.getByRole('dialog', { name: 'Revert this commit?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('undoes');
    expect(await readFile(styleFile, 'utf8')).toContain('Longer answers');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(items).toHaveCount(before);
    expect(await readFile(styleFile, 'utf8')).toContain('Longer answers');

    // Escape cancels too.
    await items.first().getByRole('button', { name: 'Revert' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(items).toHaveCount(before);

    await items.first().getByRole('button', { name: 'Revert' }).click();
    await dialog.getByRole('button', { name: 'Revert commit' }).click();
    await expect(page.getByRole('status')).toContainText('Reverted');
    await expect(items).toHaveCount(before + 1);
    expect(await readFile(styleFile, 'utf8')).toContain('Short answers');
    expect(await readFile(styleFile, 'utf8')).not.toContain('Longer answers');
  });
});

test.describe('secrets', () => {
  test('a note that already holds a secret is shown redacted, and cannot overwrite it', async ({ page, app }) => {
    await page.goto(app.url);
    // Wait until the app is up, then follow a link a person could have bookmarked.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = '#/library/profile/legacy';
    });
    await expect(page.getByTestId('editor')).toHaveValue(/Keep this line\./);
    await expect(page.getByTestId('editor')).toHaveValue(/\[redacted\]/);
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
    await expect(page.getByTestId('preview')).toContainText('[redacted]');
    await expect(page.getByRole('alert')).toContainText('hidden as [redacted]');

    // Saving would write "[redacted]" over the real line, so it is not offered.
    await page.getByTestId('editor').fill((await page.getByTestId('editor').inputValue()) + '\nMore.\n');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(await readFile(path.join(app.libraryDir, 'profile', 'legacy.md'), 'utf8')).toContain(FAKE_KEY);
  });

  test('after a refused save the secret stays in the editor and nowhere else on the page', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Profile' }).click();
    await page.getByRole('link', { name: 'style' }).click();

    const editor = page.getByTestId('editor');
    await editor.fill(`# Style\n\nKey ${FAKE_KEY}\n`);
    // Typing it does not put it in the preview either.
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
    await expect(page.getByTestId('preview')).toContainText('[redacted]');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('looks like it contains a secret (line 3)');
    await expect(editor).toHaveValue(new RegExp(FAKE_KEY));
    expect(await everywhere(page)).not.toContain(FAKE_KEY);

    // Banner, list and history stay clean too.
    await page.getByRole('link', { name: 'Profile' }).click();
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
    await page.getByRole('link', { name: 'History' }).click();
    expect(await everywhere(page)).not.toContain(FAKE_KEY);
    expect(await readFile(path.join(app.libraryDir, 'profile', 'style.md'), 'utf8')).not.toContain(FAKE_KEY);
  });
});

test.describe('usage', () => {
  test('changes the level with its card and keeps it after a reload', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Usage' }).click();
    const levels = page.getByRole('group', { name: 'Usage level' });
    await expect(levels.getByRole('radio', { name: /^Balanced/ })).toBeChecked();
    await expect(page.getByTestId('level-hint')).toContainText('Moderate use');
    // Each agent's model and effort under the active profile.
    await expect(page.getByRole('table')).toContainText('architect');

    await levels.getByRole('radio', { name: /^Max/ }).check();
    await expect(page.getByRole('status')).toContainText('Profile set to max.');
    await expect(page.getByTestId('active-profile')).toContainText('Max');
    await expect(page.getByTestId('level-hint')).toContainText('Heaviest use');
    await page.reload();
    await expect(page.getByRole('group', { name: 'Usage level' }).getByRole('radio', { name: /^Max/ })).toBeChecked();

    const agents = await readFile(path.join(app.repoDir, '.claude', 'agents', 'architect.md'), 'utf8');
    expect(agents).toMatch(/^model: /m);
    await expect(page.getByTestId('active-profile')).toContainText('Max');
  });

  test('offers the user presets as cards of their own', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Usage' }).click();
    await expect(page.getByRole('heading', { name: 'Your presets' })).toBeVisible();
    await page.getByRole('radio', { name: /^Deep dive/ }).check();
    await expect(page.getByRole('status')).toContainText('Profile set to deep-dive.');
    await expect(page.getByTestId('active-profile')).toContainText('Deep dive: my own preset');
    await expect(page.getByTestId('active-profile')).toContainText('A custom preset is active.');
  });

  test('shows qualitative text and no token or cost figures', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Usage' }).click();
    await expect(page.getByRole('heading', { name: 'Warnings' })).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\btokens?\b.*\d|\$\s?\d|\d+\s?(k|K)\s?tokens/);
  });
});

test.describe('usage and settings at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('never scroll sideways, even with long paths', async ({ page, app }) => {
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.goto(app.url);
    await clickNav(page, 'Usage');
    await expect(page.getByTestId('active-profile')).toBeVisible();
    await expect.poll(sideways).toBeLessThanOrEqual(0);
    await clickNav(page, 'Settings');
    await expect(page.getByTestId('paths')).toContainText(app.libraryDir);
    await expect.poll(sideways).toBeLessThanOrEqual(0);
  });
});

test.describe('settings, starting in Spanish', () => {
  test.use({ appOptions: { lang: 'es' }, locale: 'es-ES' });

  test('a language chosen in Settings is still there after a reload (F5)', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByRole('link', { name: 'Proyectos' })).toBeVisible();
    await page.getByRole('link', { name: 'Ajustes' }).click();
    await page.getByRole('group', { name: 'Idioma' }).getByRole('button', { name: 'English' }).click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status')).toContainText('Settings saved.');
    expect(await readFile(path.join(app.home, 'config.json'), 'utf8')).toContain('"lang": "en"');

    // The settings answer is slow on purpose: even before it arrives, the page is already in the chosen language.
    await page.route('**/api/settings', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.reload();
    await expect(page.getByRole('status').first()).toHaveText('Connecting…');
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.unroute('**/api/settings');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('settings', () => {
  test('shows the resolved paths read-only', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Settings' }).click();
    const paths = page.getByTestId('paths');
    await expect(paths).toContainText(app.libraryDir);
    await expect(paths).toContainText(app.sessionsDir);
  });

  test('changes the projects folder and creates it', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Settings' }).click();
    const target = path.join(app.dir, 'elsewhere', 'my projects');
    await page.getByLabel('Projects folder').fill(target);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Settings saved.');
    await expect(page.getByTestId('paths')).toContainText(target);
    expect((await readFile(path.join(app.home, 'config.json'), 'utf8'))).toContain('my projects');
  });

  test('says before saving that a missing projects folder will be created', async ({ page, app }) => {
    await mkdir(path.join(app.dir, 'already-there'), { recursive: true });
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Settings' }).click();
    const field = page.getByLabel('Projects folder');
    const note = page.getByTestId('folder-note');
    await expect(field).toHaveValue(app.projectsDir);
    await expect(note).toHaveCount(0);

    await field.fill(path.join(app.dir, 'not-yet', 'projects'));
    await expect(note).toContainText('does not exist yet');
    // Nothing is created until Save.
    await expect(stat(path.join(app.dir, 'not-yet'))).rejects.toThrow();

    await field.fill(path.join(app.dir, 'already-there'));
    await expect(note).toHaveCount(0);
    await field.fill(app.libraryDir);
    await expect(note).toHaveCount(0);
  });

  test('refuses what the CLI refuses: a relative path, and a folder over the library or a file', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Settings' }).click();
    const field = page.getByLabel('Projects folder');
    const save = page.getByRole('button', { name: 'Save' });

    await field.fill('projects');
    await save.click();
    await expect(page.getByRole('alert')).toContainText('Use a full path');

    await field.fill(app.libraryDir);
    await save.click();
    await expect(page.getByRole('alert')).toContainText('overlaps your personal library');

    await field.fill(app.repoDir);
    await save.click();
    await expect(page.getByRole('alert')).toContainText('overlaps the briefstack repository');

    await field.fill(path.join(app.gardenDir, 'NEXT_STEPS.md'));
    await save.click();
    await expect(page.getByRole('alert')).toContainText('is a file');

    expect(await readFile(path.join(app.home, 'config.json'), 'utf8')).not.toContain('NEXT_STEPS');
  });

  test('switches the language and the permission policy', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Español' }).click();
    await page.getByLabel('Unattended').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Ajustes guardados.');
    await expect(page.getByRole('link', { name: 'Proyectos' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.reload();
    await expect(page.getByRole('link', { name: 'Proyectos' })).toBeVisible();
    await expect(page.getByLabel('Desatendido')).toBeChecked();
  });
});

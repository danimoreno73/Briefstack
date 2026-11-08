import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { clickNav, expect, test, type App } from './fixtures.js';

// Codex in Settings (phase 8, decisions.md "Phase 8: step 25"), over the
// fake Codex CLI: off by default, the measured warning when it is switched
// on, the status only when "Check" is pressed.

const card = (page: Page) => page.getByTestId('codex-card');
const ran = async (app: App): Promise<string[][]> =>
  (await readFile(app.codexLog, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
const windows = process.platform === 'win32';

test.describe('Codex in Settings', () => {
  test('is off by default, and opening the page runs nothing', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Settings');
    await expect(card(page).getByRole('heading', { name: 'Codex in tasks' })).toBeVisible();
    await expect(card(page).getByLabel('Let Claude use Codex in tasks')).not.toBeChecked();
    await expect(card(page).getByTestId('codex-never-checked')).toHaveText('Not checked yet.');
    await expect(card(page).getByTestId('codex-availability')).toHaveText('Task rounds do not get the Codex tool: it is off.');
    await expect(card(page).getByTestId('codex-warning')).toHaveCount(0);
    await expect(card(page).getByLabel('Codex calls per round')).toHaveValue('5');
    expect(await ran(app)).toEqual([]);
  });

  test('switching it on shows what was measured; applied, it stays after a reload; Check makes the tool available', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Settings');
    await card(page).getByLabel('Let Claude use Codex in tasks').check();
    const warning = card(page).getByTestId('codex-warning');
    await expect(warning).toContainText('Codex can read your files and use the network (the Internet and local services) from this computer.');
    await expect(warning).toContainText('It cannot write outside the task’s folder or change git. Always review the diff. Its use counts against your ChatGPT plan.');
    await expect(warning.locator('strong')).toHaveText(['read your files', 'use the network']);
    if (windows) {
      // The mode is offered on Windows, unelevated by default; the warning follows it.
      await expect(card(page).getByRole('radio', { name: /Unelevated \(default\)/ })).toBeChecked();
      await expect(warning).toContainText('It runs as you.');
      await card(page).getByRole('radio', { name: /^Elevated/ }).check();
      await expect(warning).toContainText('It will not be able to run Node installed in your profile (for example with nvm).');
      await card(page).getByRole('radio', { name: /Unelevated/ }).check();
    } else {
      await expect(card(page).getByTestId('codex-mode-not-offered')).toHaveText('The sandbox mode is only offered on Windows: not verified on this system.');
      await expect(card(page).getByRole('radio')).toHaveCount(0);
    }
    await card(page).getByLabel('Codex calls per round').fill('3');
    await card(page).getByRole('button', { name: 'Apply Codex settings' }).click();
    await expect(card(page).getByTestId('codex-saved')).toHaveText('Codex settings applied.');
    const config = JSON.parse(await readFile(path.join(app.home, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({ codexEnabled: true, codexMaxCalls: 3 });

    await page.reload();
    await expect(card(page).getByLabel('Let Claude use Codex in tasks')).toBeChecked();
    await expect(card(page).getByLabel('Codex calls per round')).toHaveValue('3');
    await expect(card(page).getByTestId('codex-availability')).toHaveText('Task rounds do not get the Codex tool: check its status first.');
    expect(await ran(app)).toEqual([]);

    await card(page).getByRole('button', { name: 'Check', exact: true }).click();
    await expect(card(page).getByTestId('codex-availability')).toHaveText('Task rounds get the Codex tool.');
    await expect(card(page).getByTestId('codex-version')).toHaveAttribute('data-ok', 'true');
    await expect(card(page).getByTestId('codex-version')).toContainText('codex-cli 0.167.0');
    await expect(card(page).getByTestId('codex-login')).toContainText('Logged in using ChatGPT');
    await expect(card(page).getByTestId('codex-sandbox')).toHaveAttribute('data-ok', 'true');
    const commands = await ran(app);
    expect(commands.map((argv) => argv.slice(0, 2))).toEqual([['--version'], ['login', 'status'], ['sandbox', ...(windows ? ['-c'] : ['-P'])]]);
    // A task round now gets the tool.
    expect(await app.codex.session()).toMatchObject({ maxCalls: 3 });
  });

  test('calls per round past 10 are not applied', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Settings');
    const field = card(page).getByLabel('Codex calls per round');
    await field.fill('11');
    await card(page).getByRole('button', { name: 'Apply Codex settings' }).click();
    // The browser holds the form back (the field's range); the server refuses it too (tests/unit/codex-settings.test.ts).
    expect(await field.evaluate((input) => (input as HTMLInputElement).validity.rangeOverflow)).toBe(true);
    await expect(card(page).getByTestId('codex-saved')).toHaveCount(0);
    expect(JSON.parse(await readFile(path.join(app.home, 'config.json'), 'utf8')) as Record<string, unknown>).not.toHaveProperty('codexMaxCalls');
  });
});

test.describe('Codex in Settings, not signed in to Codex', () => {
  test.use({ appOptions: { codexScenario: 'loggedOut' } });

  test('a failed login shows, and the tool stays unavailable', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Settings');
    await card(page).getByLabel('Let Claude use Codex in tasks').check();
    await card(page).getByRole('button', { name: 'Apply Codex settings' }).click();
    await expect(card(page).getByTestId('codex-saved')).toBeVisible();
    await card(page).getByRole('button', { name: 'Check', exact: true }).click();
    await expect(card(page).getByTestId('codex-login')).toHaveAttribute('data-ok', 'false');
    await expect(card(page).getByTestId('codex-login')).toContainText('Not logged in');
    await expect(card(page).getByTestId('codex-availability')).toHaveText('Task rounds do not get the Codex tool: the last check did not pass.');
    expect(await app.codex.session()).toBeUndefined();
  });
});

test.describe('Codex in Settings, in Spanish', () => {
  test.use({ appOptions: { lang: 'es' } });

  test('the warning is the measured text', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Ajustes' }).click();
    await card(page).getByLabel('Dejar que Claude use Codex en las tareas').check();
    const warning = card(page).getByTestId('codex-warning');
    await expect(warning).toContainText(
      'Codex puede leer tus ficheros y usar la red (Internet y servicios locales) desde este equipo. No puede escribir fuera de la carpeta de la tarea ni modificar git. Revisa siempre el diff. Su uso cuenta contra tu plan de ChatGPT.',
    );
    await expect(warning.locator('strong')).toHaveText(['leer tus ficheros', 'usar la red']);
    if (windows) await expect(warning).toContainText('Se ejecuta como tú.');
    else await expect(card(page).getByTestId('codex-mode-not-offered')).toHaveText('El modo de sandbox solo se ofrece en Windows: no verificado en este sistema.');
  });
});

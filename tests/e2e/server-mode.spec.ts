import type { Page } from '@playwright/test';
import { clickNav, expect, test } from './fixtures.js';

// Phase 12, M2: server mode's sign-in once per device, the devices in
// Settings, sign-out and revoke (PLAN-phase-12 §1, 4 to 6). The browser
// reaches the server at its loopback address, which server mode accepts
// beside its configured names.

// Built at run time: no file in the repo holds a secret-looking value.
const SECRET = ['e2e', 'k'.repeat(40)].join('-');

async function signIn(page: Page, secret = SECRET): Promise<void> {
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await page.getByLabel('Access secret').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('server mode', () => {
  test.use({ appOptions: { serverSecret: SECRET } });

  test('signs in once with the access secret and stays signed in after a reload and in a new tab', async ({ page, app, context }) => {
    await page.goto(app.url);
    await signIn(page, `${SECRET}-wrong`);
    await expect(page.getByTestId('sign-in-error')).toHaveText('That is not the access secret.');
    await expect(page.getByLabel('Access secret')).toHaveValue('');
    await signIn(page);
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    await clickNav(page, 'Settings');
    expect(page.url()).not.toContain(SECRET);
    await expect(page.getByTestId('device')).toHaveCount(1);
    await expect(page.getByTestId('device')).toHaveAttribute('data-current', 'true');
    // The cookie cannot be read by the page's scripts.
    expect(await page.evaluate(() => document.cookie)).toBe('');

    await page.reload();
    await expect(page.getByTestId('devices-card')).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);

    const tab = await context.newPage();
    await tab.goto(app.url);
    await clickNav(tab, 'Settings');
    await expect(tab.getByTestId('device')).toHaveCount(1);
  });

  test('another device signed out from Settings has to sign in again, and so does every device after "sign out every device"', async ({ page, app, browser }) => {
    const phoneContext = await browser.newContext();
    const phone = await phoneContext.newPage();
    try {
      await phone.goto(app.url);
      await signIn(phone);
      await expect(phone.getByTestId('sign-in')).toHaveCount(0);

      await page.goto(app.url);
      await signIn(page);
      await clickNav(page, 'Settings');
      await expect(page.getByTestId('device')).toHaveCount(2);
      await page.locator('[data-testid="device"][data-current="false"]').getByTestId('device-revoke').click();
      await expect(page.getByTestId('device')).toHaveCount(1);

      await phone.reload();
      await expect(phone.getByTestId('sign-in')).toBeVisible();

      await page.getByTestId('devices-revoke-all').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out every device' }).click();
      await expect(page.getByTestId('sign-in')).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('sign-in')).toBeVisible();
    } finally {
      await phoneContext.close();
    }
  });

  test('signing this device out asks for the secret again', async ({ page, app }) => {
    await page.goto(app.url);
    await signIn(page);
    await clickNav(page, 'Settings');
    await page.locator('[data-testid="device"][data-current="true"]').getByTestId('device-revoke').click();
    await expect(page.getByTestId('sign-in')).toBeVisible();
  });
});

test('local mode has no sign-in and no devices card', async ({ page, app }) => {
  await page.goto(app.url);
  await clickNav(page, 'Settings');
  await expect(page.getByTestId('claude-card')).toBeVisible();
  await expect(page.getByTestId('devices-card')).toHaveCount(0);
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
});

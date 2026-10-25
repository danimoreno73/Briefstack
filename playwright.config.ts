import { defineConfig } from '@playwright/test';

// End-to-end tests start their own server over temp folders and the fake
// runner (tests/e2e/fixtures.ts), so there is no `webServer` here and no
// login or tokens are involved. `npm run test:e2e` builds the UI first.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry in CI only: the Windows runner has slowed the same test from 3 s
  // to over 30 s between runs of the same code (docs/decisions.md, "Release").
  // A retried test is reported as flaky, so it still shows.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});

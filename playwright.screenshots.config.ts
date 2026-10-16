import { defineConfig } from '@playwright/test';

// Screenshots of the agent panel over the fake runner, for a person to look
// at (BRIEF-phase-3 §6). Not part of the test suite. They are written to
// `screenshots/`, which git ignores. Run: `npm run screenshots`.
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: '**/*.shots.ts',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { browserName: 'chromium' },
});

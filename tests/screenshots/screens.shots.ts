import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { clickNav, expect, test, type App } from '../e2e/fixtures.js';

// The screens moved to bs.css in U5, one entry per screen, at desktop and
// phone width in both themes. Output: `screenshots/u5/screens/`, git-ignored.
// `SHOTS_ONLY` keeps the screens whose name starts with one of its prefixes.
// Run: `npm run screenshots -- screens.shots.ts`.
const OUT = path.join(PACKAGE_ROOT, 'screenshots', 'u5', 'screens');
const ONLY = process.env.SHOTS_ONLY?.split(',');
const VIEWS = [
  { name: '1280-dark', width: 1280, height: 900, scheme: 'dark' },
  { name: '1280-light', width: 1280, height: 900, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, scheme: 'light' },
] as const;

interface Screen {
  name: string;
  /** Opens the screen and waits until it shows what the picture is for. */
  open(page: Page, app: App): Promise<void>;
}

const SCREENS: Screen[] = [
  {
    name: 'usage',
    open: async (page) => {
      await clickNav(page, 'Usage');
      await expect(page.getByTestId('active-profile')).toBeVisible();
    },
  },
  {
    name: 'settings',
    open: async (page) => {
      await clickNav(page, 'Settings');
      await expect(page.getByTestId('paths')).toBeVisible();
      // The limit's note shows above three.
      await page.getByRole('button', { name: '4', exact: true }).click();
    },
  },
];

// A full-page picture stitches the page: what stays in place while scrolling would land in the middle.
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage: true,
    style: '.sticky, .rail, .topbar, .head-bar { position: static !important; } .rail { height: auto !important; align-self: stretch !important; }',
  });
};

for (const view of VIEWS) {
  test.describe(`screens at ${view.name}`, () => {
    test.use({ viewport: { width: view.width, height: view.height }, colorScheme: view.scheme });
    for (const screen of SCREENS.filter((item) => ONLY === undefined || ONLY.some((prefix) => item.name.startsWith(prefix)))) {
      test(screen.name, async ({ page, app }) => {
        await page.goto(app.url);
        await screen.open(page, app);
        await shot(page, `${screen.name}-${view.name}`);
      });
    }
  });
}

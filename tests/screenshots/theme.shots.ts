import path from 'node:path';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { expect, test } from '../e2e/fixtures.js';

// The theme menu in the rail's foot, open from the keyboard (so the focus
// ring shows), at desktop and phone width in both themes: the whole window
// and a close-up of the rail's foot. Output: `screenshots/u5/theme/`,
// git-ignored. Run: `npm run screenshots -- theme.shots.ts`.
const OUT = path.join(PACKAGE_ROOT, 'screenshots', 'u5', 'theme');
const VIEWS = [
  { name: '1280-light', width: 1280, height: 800, scheme: 'light' },
  { name: '1280-dark', width: 1280, height: 800, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, scheme: 'dark' },
] as const;

for (const view of VIEWS) {
  test.describe(`theme menu at ${view.name}`, () => {
    test.use({ viewport: { width: view.width, height: view.height }, colorScheme: view.scheme });
    test(view.name, async ({ page, app }) => {
      await page.goto(app.url);
      await expect(page.getByTestId('projects')).toBeVisible();
      if (view.width < 720) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const theme = page.getByRole('button', { name: /^Theme:/ });
      await expect(theme).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `closed-${view.name}.png`) });

      await theme.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitemradio', { name: 'Light' })).toBeFocused();
      await page.screenshot({ path: path.join(OUT, `open-${view.name}.png`) });
      // The menu opens above the foot, outside its box: the close-up takes both.
      const foot = await page.locator('.rail-foot').boundingBox();
      const menu = await page.getByRole('menu', { name: 'Theme' }).boundingBox();
      if (foot === null || menu === null) throw new Error('The rail foot or the menu is not on screen.');
      const top = Math.max(0, Math.min(foot.y, menu.y) - 16);
      await page.screenshot({ path: path.join(OUT, `open-foot-${view.name}.png`), clip: { x: foot.x, y: top, width: foot.width, height: foot.y + foot.height - top } });
    });
  });
}

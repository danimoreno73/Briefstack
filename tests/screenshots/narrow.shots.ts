import path from 'node:path';
import type { Page } from '@playwright/test';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import type { PlanOutput, QueueItem } from '../../src/builds/types.js';
import type { TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { clickNav, codeProject, expect, test, type App } from '../e2e/fixtures.js';

// Phase 12, H0 item 4: which pages break on a phone-sized screen. Each page
// is opened at 390×844 and measured: how far the document scrolls sideways,
// and the elements that stick out past the right edge outside a container
// that scrolls on its own. Output: `screenshots/phase-12/narrow/` (pictures)
// and one line per page on stdout. Not part of the test suite.
// Run: `npm run screenshots -- narrow.shots.ts`.
const OUT = path.join(PACKAGE_ROOT, 'screenshots', 'phase-12', 'narrow');

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ timeout: 90_000 });

const SLOW = { timeout: 30_000 };
const BRIEF = '# Garden: brief\n\n## Deliverables\n\n- Notes.\n- A summary.\n';
const card = (title: string, area: string[], dependsOn: number[] = []): QueueItem => ({ title, instruction: `Write ${title}.`, doneWhen: 'Done.', dependsOn, area, size: 'S' });
const PLAN: PlanOutput = { tasks: [card('Notes with a rather long title that wraps', ['NOTES.md', 'notes/very/long/path/to/a/folder/']), card('Summary', ['SUMMARY.md'], [1])], commands: ['npm test', 'npx tsc --noEmit -p tsconfig.json'], checks: [] };
const writes: TaskFakeScript = (_round, prompt) => ({ steps: [{ kind: 'write', file: `${/Write (\w+)/.exec(prompt)?.[1] ?? 'X'}.md`, content: 'x\n' }, { kind: 'end', summary: 'Done.' }] });

async function measure(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (el: Element | null): boolean => {
      for (let node = el?.parentElement ?? null; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden') return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= width + 1 || scrolls(el)) continue;
      const id = el.getAttribute('data-testid') ?? el.id ?? '';
      out.push(`${el.tagName.toLowerCase()}${id === '' ? '' : `[${id}]`}${typeof el.className === 'string' && el.className !== '' ? `.${el.className.split(' ').slice(0, 2).join('.')}` : ''} right=${Math.round(rect.right)}`);
    }
    return { sideways: document.documentElement.scrollWidth - width, out: out.slice(0, 8), count: out.length };
  });
  console.log(`NARROW ${name}: sideways=${result.sideways}px, sticking out=${result.count}${result.count > 0 ? ` (${result.out.join('; ')})` : ''}`);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function goTo(page: Page, app: App, hash: string): Promise<void> {
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate((target) => (window.location.hash = target), hash);
}

test('projects, project detail, new project, settings, usage', async ({ page, app }) => {
  await page.goto(app.url);
  await expect(page.getByTestId('projects')).toBeVisible();
  await measure(page, 'projects');
  await page.getByRole('link', { name: 'Garden planner' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await measure(page, 'project-detail');
  await clickNav(page, 'New project');
  await measure(page, 'new-project');
  await clickNav(page, 'Settings');
  await expect(page.getByTestId('paths')).toBeVisible();
  await measure(page, 'settings');
  await clickNav(page, 'Usage');
  await measure(page, 'usage');
});

test('a creation: interview and spec checkpoint', async ({ page, app }) => {
  await page.goto(app.url);
  await clickNav(page, 'New project');
  await page.getByLabel('Describe your idea').fill('A garden planner for my family, with a planting calendar.');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { name: 'The flow needs your answers' })).toBeVisible(SLOW);
  await measure(page, 'creation-interview');
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByText('Which seasons should it cover?')).toBeVisible(SLOW);
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByRole('heading', { name: 'Approve the spec' })).toBeVisible(SLOW);
  await measure(page, 'creation-spec');
});

test.describe('a build', () => {
  test.use({ appOptions: { taskScript: writes, buildPlan: PLAN } });

  test('the board before the start, the build page while it runs and once finished', async ({ page, app }) => {
    await codeProject(app, 'garden', 'Garden', { 'docs/BRIEF.md': BRIEF });
    await goTo(page, app, '#/projects/garden');
    await measure(page, 'code-project');
    await page.getByTestId('build-implement').click();
    await expect(page.getByTestId('build-start-form')).toBeVisible(SLOW);
    await measure(page, 'build-board');
    await page.getByTestId('build-no-checks-confirm').check();
    await page.getByTestId('build-start').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start the build' }).click();
    await expect(page).toHaveURL(/#\/builds\//, SLOW);
    await measure(page, 'build-page');
    await expect(page.getByTestId('build-state')).toHaveText('Finished', { timeout: 60_000 });
    await measure(page, 'build-finished');
  });
});

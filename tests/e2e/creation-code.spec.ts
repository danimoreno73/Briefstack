import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { updateConfig } from '../../src/config/index.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specInput } from '../helpers.js';
import { clickNav, expect, test } from './fixtures.js';

// Phase 10: a creation that writes a first version of the code. M1, the spec checkpoint: the code choice is offered
// for a software project for Claude Code only, "workspace only" is the default, the warning stays next to the
// choice, the lists are checked as builds' are, and Codex's checkbox shows only when the no-shell check passed.

function recording(spec: SpecInput): string {
  return [
    { do: 'session', phase: 'started' },
    { do: 'flow', step: 'spec', phase: 'started' },
    { do: 'label', name: 'write' },
    { do: 'spec', onChange: 'write', spec: JSON.stringify(spec), summary: '# Garden\n\nA garden planner.\n' },
    { do: 'flow', step: 'spec', phase: 'finished', outcome: 'ok' },
    { do: 'session', phase: 'finished', outcome: 'completed' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

const SOFTWARE = specInput({ slug: 'garden', name: 'Garden', type: 'software', target: 'claude-code' });

test.describe('the code choice at the spec checkpoint', () => {
  test.use({ appOptions: { recordingText: recording(SOFTWARE) } });

  test('workspace only by default; code shows the warning and the lists; a bad list is refused; a good one is recorded', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A garden planner');
    await page.getByRole('button', { name: 'Start' }).click();
    const card = page.getByTestId('spec-code');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('spec-code-workspace')).toBeChecked();
    await expect(card.getByTestId('spec-code-warning')).toHaveCount(0);
    await expect(card.getByTestId('spec-code-codex')).toHaveCount(0);

    await card.getByTestId('spec-code-with-code').check();
    await expect(card.getByTestId('spec-code-warning')).toContainText('before anyone reads it');
    await card.getByTestId('spec-code-commands').fill('npm install\nnpm test && rm -rf .');
    await card.getByTestId('spec-code-checks').fill('npm test');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('more than one command')).toBeVisible();
    await expect(card).toBeVisible();

    await card.getByTestId('spec-code-commands').fill('npm install\nnpm test');
    await card.getByTestId('spec-code-fix-passes').selectOption('2');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 15_000 });
    const [state] = app.manager.list();
    expect(state?.code).toEqual({ commands: ['npm install', 'npm test'], checks: ['npm test'], fixPasses: 2, codex: false });
    expect(JSON.parse(await readFile(path.join(app.sessionsDir, state?.sessionId ?? '', 'code.json'), 'utf8'))).toMatchObject({ v: 1, fixPasses: 2 });
  });

  test('Codex checked and passing: the checkbox shows, off by default', async ({ page, app }) => {
    await updateConfig(path.join(app.home, 'config.json'), { codexEnabled: true });
    await app.codex.check();
    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A garden planner');
    await page.getByRole('button', { name: 'Start' }).click();
    const card = page.getByTestId('spec-code');
    await card.getByTestId('spec-code-with-code').check();
    await expect(card.getByTestId('spec-code-codex')).not.toBeChecked();
    await card.getByTestId('spec-code-commands').fill('npm test');
    await card.getByTestId('spec-code-codex').check();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 15_000 });
    expect(app.manager.list()[0]?.code).toMatchObject({ codex: true, fixPasses: 1, checks: [] });
  });
});

test.describe('a spec that is not software for Claude Code', () => {
  test.use({ appOptions: { recordingText: recording(specInput({ slug: 'notes', type: 'generic', target: 'claude-code' })) } });

  test('has no code choice; approving is as before', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('Some notes');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('spec-summary')).toBeVisible();
    await expect(page.getByTestId('spec-code')).toHaveCount(0);
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 15_000 });
    expect(app.manager.list()[0]?.code).toBeUndefined();
  });
});

test.describe('the code choice, in Spanish', () => {
  test.use({ appOptions: { recordingText: recording(SOFTWARE), lang: 'es' } });

  test('the choice and the warning are in Spanish', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Proyecto nuevo', exact: true }).first().click();
    await page.getByLabel('Describe tu idea').fill('Un planificador de huerto');
    await page.getByRole('button', { name: 'Empezar' }).click();
    const card = page.getByTestId('spec-code');
    await expect(card).toContainText('Solo el espacio de trabajo');
    await card.getByTestId('spec-code-with-code').check();
    await expect(card.getByTestId('spec-code-warning')).toContainText('antes de que nadie lo lea');
  });
});

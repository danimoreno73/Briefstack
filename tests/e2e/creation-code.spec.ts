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
    // No check at all is refused (review of M1, I3), in the page's words.
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('add at least one check')).toBeVisible();
    await card.getByTestId('spec-code-checks').fill('npm test');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 15_000 });
    expect(app.manager.list()[0]?.code).toMatchObject({ codex: true, fixPasses: 1, checks: ['npm test'] });
  });
});

/** M2: a creation with code, played by the fake runner through the implement step's port, with real git. */
function codeRecording(): string {
  return [
    { do: 'session', phase: 'started' },
    { do: 'claim', dir: 'garden' },
    { do: 'flow', step: 'spec', phase: 'started' },
    { do: 'label', name: 'write' },
    { do: 'spec', onChange: 'write', spec: JSON.stringify(SOFTWARE), summary: '# Garden\n\nA garden planner.\n' },
    { do: 'flow', step: 'spec', phase: 'finished', outcome: 'ok' },
    { do: 'flow', step: 'generate', phase: 'started' },
    { do: 'generate', dir: 'garden', git: true },
    { do: 'flow', step: 'generate', phase: 'finished', outcome: 'ok' },
    { do: 'flow', step: 'implement', phase: 'started' },
    { do: 'implement', action: 'start', dir: 'garden' },
    { do: 'hook', type: 'subagent.start', agentId: 'i1', agentType: 'implementer' },
    { do: 'implement', action: 'write', file: 'src/garden.js', text: 'export const beds = 3;\n' },
    { do: 'implement', action: 'run', command: 'node --version' },
    { do: 'implement', action: 'run', command: 'npm publish' },
    { do: 'hook', type: 'subagent.stop', agentId: 'i1', agentType: 'implementer' },
    { do: 'implement', action: 'finish' },
    { do: 'flow', step: 'implement', phase: 'finished', outcome: 'ok' },
    { do: 'session', phase: 'finished', outcome: 'completed' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

test.describe('a creation with code (M2)', () => {
  test.use({ appOptions: { recordingText: codeRecording() } });

  test('two commits, the listed command run, the other refused with no dialog', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A garden planner');
    await page.getByRole('button', { name: 'Start' }).click();
    const card = page.getByTestId('spec-code');
    await card.getByTestId('spec-code-with-code').check();
    await card.getByTestId('spec-code-commands').fill('node --version');
    await card.getByTestId('spec-code-checks').fill('node --version');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 20_000 });
    // No permission dialog was ever shown for the refused command.
    await expect(page.getByTestId('permission')).toHaveCount(0);
    const state = app.manager.list()[0];
    expect(state?.implement).toMatchObject({ state: 'done', refused: [{ command: 'npm publish' }] });
    expect(state?.implement?.runs.map((run) => run.command)).toEqual(['node --version']);
    expect(state?.implement?.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.implement?.codeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(app.projectsDir, 'garden', 'src', 'garden.js'), 'utf8')).toBe('export const beds = 3;\n');
  });
});

/** M3: a check that fails (node refuses an unknown option), one fix pass, then the code kept with a warning. */
function fixPassRecording(): string {
  return [
    { do: 'session', phase: 'started' },
    { do: 'claim', dir: 'garden' },
    { do: 'label', name: 'write' },
    { do: 'spec', onChange: 'write', spec: JSON.stringify(SOFTWARE) },
    { do: 'generate', dir: 'garden', git: true },
    { do: 'flow', step: 'implement', phase: 'started' },
    { do: 'implement', action: 'start', dir: 'garden' },
    { do: 'implement', action: 'write', file: 'src/garden.js', text: 'export const beds = 3;\n' },
    { do: 'implement', action: 'finish' },
    { do: 'implement', action: 'write', file: 'src/garden.js', text: 'export const beds = 4;\n' },
    { do: 'implement', action: 'finish' },
    { do: 'flow', step: 'implement', phase: 'finished', outcome: 'ok' },
    { do: 'session', phase: 'finished', outcome: 'completed' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

test.describe('failing checks with a fix pass (M3)', () => {
  test.use({ appOptions: { recordingText: fixPassRecording() } });

  test('the check runs twice; the code is committed with a warning, and the creation completes', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A garden planner');
    await page.getByRole('button', { name: 'Start' }).click();
    const card = page.getByTestId('spec-code');
    await card.getByTestId('spec-code-with-code').check();
    await card.getByTestId('spec-code-checks').fill('node --no-such-option-briefstack');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 20_000 });
    const implement = app.manager.list()[0]?.implement;
    expect(implement).toMatchObject({ state: 'done', fixPassesUsed: 1, warning: 'checksFailed' });
    expect(implement?.checks.map((c) => c.pass)).toEqual([1, 2]);
    expect(implement?.checks[1]?.results[0]?.exitCode).not.toBe(0);
    expect(implement?.codeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(app.projectsDir, 'garden', 'src', 'garden.js'), 'utf8')).toBe('export const beds = 4;\n');
  });
});

test.describe('the implement step limits in Settings (M3)', () => {
  test('shows the defaults, saves new values and refuses values out of range', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Settings' }).first().click();
    const card = page.getByTestId('settings-implement');
    await expect(card.getByLabel('Most minutes')).toHaveValue('30');
    await expect(card.getByLabel('Most tool calls of the implementer')).toHaveValue('150');
    await card.getByLabel('Most minutes').fill('45');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(path.join(app.home, 'config.json'), 'utf8')).implementMaxMinutes).toBe(45);
    await page.reload();
    await expect(page.getByTestId('settings-implement').getByLabel('Most minutes')).toHaveValue('45');
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

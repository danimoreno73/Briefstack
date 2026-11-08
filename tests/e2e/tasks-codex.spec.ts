import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { updateConfig } from '../../src/config/index.js';
import type { TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import { codeProject, expect, test, type App } from './fixtures.js';

// Codex calls on a task's page (decisions.md, "Phase 8: step 27"), over the
// fake task runner and the fake Codex CLI: no model, no network, no login.

/** A round's end runs git several times; on a busy Windows runner that alone can pass the default 5 s. */
const CHECKED = { timeout: 30_000 };

/**
 * The round's steps follow a marker in the task's text: `[slow]` one call
 * that never ends by itself; `[none]` no call; otherwise two calls, one
 * that completes and one that fails. Later rounds write a file and end.
 */
const SCRIPT: TaskFakeScript = (round, prompt) => {
  if (round > 1) return { steps: [{ kind: 'write', file: 'MORE.md', content: 'More.\n' }, { kind: 'end', summary: 'Wrote MORE.md.' }] };
  if (prompt.includes('[slow]')) return { steps: [{ kind: 'codex', instruction: 'Build it. [fake:slow]' }, { kind: 'end', summary: 'Done.' }] };
  if (prompt.includes('[none]')) return { steps: [{ kind: 'write', file: 'NOTE.md', content: 'A note.\n' }, { kind: 'end', summary: 'Wrote NOTE.md.' }] };
  return {
    steps: [
      { kind: 'codex', instruction: 'Write the note.' },
      { kind: 'codex', instruction: 'Now this. [fake:fail]' },
      { kind: 'end', summary: 'Codex wrote the note.' },
    ],
  };
};

/** Codex on and checked, as Settings leaves it after "Check": task rounds get the tool. */
async function codexOn(app: App): Promise<void> {
  await updateConfig(path.join(app.home, 'config.json'), { codexEnabled: true, codexMaxCalls: 5 });
  expect((await app.codex.check()).available).toBe(true);
}

async function openTask(page: Page, app: App, project: string, text: string): Promise<string> {
  const task = await app.tasks.start(project, text);
  await page.goto(app.url);
  await page.locator('nav#rail').waitFor({ state: 'attached' });
  await page.evaluate((target) => (window.location.hash = target), `#/tasks/${task.id}`);
  return task.id;
}

async function finishRound(page: Page): Promise<void> {
  await expect(page.getByTestId('task-turn-ended')).toBeVisible(CHECKED);
  await page.getByTestId('task-finish').click();
  await expect(page.getByTestId('task-state')).toHaveText(/Waiting for review|Pendiente de revisión/, CHECKED);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

test.describe('Codex calls on the task page', () => {
  test.use({ appOptions: { taskScript: SCRIPT } });

  test('a round with two calls shows both rows, the summary and the cost; a later round without calls adds nothing', async ({ page, app }) => {
    await codexOn(app);
    await codeProject(app, 'shed', 'Tool shed');
    await openTask(page, app, 'shed', 'Use Codex for the note.');
    await finishRound(page);

    const codex = page.getByTestId('task-codex');
    await expect(codex.getByRole('heading', { name: 'Codex', exact: true })).toBeVisible();
    await expect(codex.getByTestId('task-codex-summary')).toHaveText('2 calls to Codex in this task (limit in Settings: 5 per round)');
    // Only the completed call has usage: 1,200 input of which 1,000 cached, 50 output. As Codex counts it, 200 + 50;
    // with cache, 1,200 + 50. The failed one is counted apart, not as 0.
    await expect(codex.getByTestId('task-codex-tokens')).toHaveText('250 tokens in total, as Codex counts them (1,250 with cache); 1 call without usage data');
    await expect(codex.getByTestId('task-codex-cost')).toHaveText('Each call uses your ChatGPT plan; briefstack cannot read how much you have left.');
    const round = codex.getByTestId('task-codex-round-1');
    await expect(round.getByRole('heading')).toHaveText('Round 1: 2 / 5 calls');
    const rows = round.getByTestId('task-codex-call');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-outcome', 'completed');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('completed');
    await expect(rows.nth(0).locator('td').nth(3)).toHaveText('1');
    await expect(rows.nth(0).getByTestId('task-codex-usage-main')).toHaveText('250 tokens (1,250 with cache)');
    await expect(rows.nth(0).getByTestId('task-codex-usage-detail')).toHaveText('1,200 input (1,000 cached) · 50 output · 7 reasoning');
    await expect(rows.nth(0)).toContainText('I wrote codex-note.txt.');
    await expect(rows.nth(1)).toHaveAttribute('data-outcome', 'failed');
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('failed');
    await expect(rows.nth(1).getByTestId('task-codex-usage')).toHaveText('no usage data');
    await expect(rows.nth(1)).toContainText('(no message)');
    // Codex's file is in the diff, like any other change of the round.
    await expect(page.getByTestId('task-diff')).toContainText('codex-note.txt');

    // A second round without Codex: the first round's section stays, no section for round 2.
    await page.getByTestId('task-changes').fill('One more file.');
    await page.getByTestId('task-changes-send').click();
    await finishRound(page);
    await expect(codex.getByTestId('task-codex-round-1')).toBeVisible();
    await expect(codex.getByTestId('task-codex-round-2')).toHaveCount(0);
    await expect(codex.getByTestId('task-codex-summary')).toHaveText('2 calls to Codex in this task (limit in Settings: 5 per round)');
  });

  test('a task whose rounds have no Codex call shows no Codex section', async ({ page, app }) => {
    await codexOn(app);
    await codeProject(app, 'shed', 'Tool shed');
    await openTask(page, app, 'shed', 'A note by hand. [none]');
    await finishRound(page);
    await expect(page.getByTestId('task-diff')).toContainText('NOTE.md');
    await expect(page.getByTestId('task-codex')).toHaveCount(0);
  });

  test('cancelling while Codex works: the page says it works, the call ends cancelled, the task too, and no child is left', async ({ page, app }) => {
    await codexOn(app);
    await codeProject(app, 'shed', 'Tool shed');
    const id = await openTask(page, app, 'shed', 'A long build. [slow]');
    await expect(page.getByTestId('task-codex-working')).toHaveText('Codex is working…', CHECKED);
    await expect(page.getByTestId('task-cancel-hint')).toHaveText('Ends the session; if Codex is working, it stops Codex and everything it started too.');

    // The fake Codex's child writes its pid next to the call's output file.
    const outDir = path.join(app.home, 'tasks', id, 'codex');
    let heartbeat = '';
    await expect
      .poll(async () => {
        if (!existsSync(outDir)) return false;
        const name = (await readdir(outDir)).find((file) => file.endsWith('.heartbeat'));
        if (name !== undefined) heartbeat = path.join(outDir, name);
        return name !== undefined;
      }, CHECKED)
      .toBe(true);
    const child = (JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number }).pid;

    await page.getByTestId('task-cancel').click();
    await expect(page.getByTestId('task-state')).toHaveText('Cancelled', CHECKED);
    await expect(page.getByTestId('task-codex-working')).toHaveCount(0);
    const rows = page.getByTestId('task-codex').getByTestId('task-codex-call');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toHaveAttribute('data-outcome', 'cancelled');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('cancelled');
    await expect(rows.nth(0).getByTestId('task-codex-usage')).toHaveText('no usage data');
    await expect(page.getByTestId('task-codex').getByTestId('task-codex-tokens')).toHaveText('0 tokens in total, as Codex counts them (0 with cache); 1 call without usage data');
    expect((await app.tasks.get(id)).rounds[0]?.codex?.map((call) => call.outcome)).toEqual(['cancelled']);
    await expect.poll(() => alive(child), CHECKED).toBe(false);
  });
});

test.describe('Codex calls on the task page, in Spanish', () => {
  test.use({ appOptions: { lang: 'es', taskScript: SCRIPT } });

  test('the section, its rows and the cost notice are in Spanish', async ({ page, app }) => {
    await codexOn(app);
    await codeProject(app, 'shed', 'Tool shed');
    await openTask(page, app, 'shed', 'Usa Codex para la nota.');
    await finishRound(page);
    const codex = page.getByTestId('task-codex');
    await expect(codex.getByTestId('task-codex-summary')).toHaveText('2 llamadas a Codex en esta tarea (tope en Ajustes: 5 por ronda)');
    await expect(codex.getByTestId('task-codex-tokens')).toHaveText('250 tokens en total, como los cuenta Codex (1.250 con caché); 1 llamada sin datos de uso');
    await expect(codex.getByTestId('task-codex-cost')).toHaveText('Cada llamada gasta de tu plan de ChatGPT; briefstack no puede leer lo que te queda.');
    await expect(codex.getByTestId('task-codex-round-1').getByRole('heading')).toHaveText('Ronda 1: 2 / 5 llamadas');
    const rows = codex.getByTestId('task-codex-call');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('completada');
    await expect(rows.nth(0).getByTestId('task-codex-usage-main')).toHaveText('250 tokens (1.250 con caché)');
    await expect(rows.nth(0).getByTestId('task-codex-usage-detail')).toHaveText('1.200 de entrada (1.000 en caché) · 50 de salida · 7 de razonamiento');
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('falló');
    await expect(rows.nth(1).getByTestId('task-codex-usage')).toHaveText('sin datos de uso');
    await expect(codex.getByRole('columnheader')).toHaveText(['Llamada', 'Resultado', 'Tiempo', 'Comandos', 'Tokens', 'Mensaje final de Codex']);
  });
});

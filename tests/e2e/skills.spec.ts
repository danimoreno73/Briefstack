import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { computeSuggestions } from '../../src/improve/suggestions.js';
import { readInstalled } from '../../src/skills/install.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { scaffold } from '../../src/scaffold/index.js';
import { parseSpec } from '../../src/spec/index.js';
import { baseProfilesFile, loadUsageProfiles } from '../../src/usage/profiles.js';
import { specInput } from '../helpers.js';
import { fakeSha } from '../skillsWorld.js';
import { clickNav, expect, recordProject, test, type App } from './fixtures.js';

// Phase 6 (BRIEF-phase-6 §5): the skill library, the plan-usage warning,
// archived projects and discarded suggestions, over the fake runners and a
// local fake GitHub.

const TIDY = 'https://github.com/acme/skills/tree/main/skills/tidy';
const SYNC = 'https://github.com/acme/skills/tree/main/skills/sync';

async function openSkills(page: Page, app: App): Promise<void> {
  await page.goto(app.url);
  await clickNav(page, 'Skills');
  await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible();
}

async function addFromPage(page: Page, url: string): Promise<void> {
  await page.getByLabel('GitHub link to the skill').fill(url);
  await page.getByRole('button', { name: 'Fetch into quarantine' }).click();
}

async function confirmModal(page: Page, name: string): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}

async function say(page: Page, text: string): Promise<void> {
  const box = page.getByTestId('chat-panel').getByLabel('Your message');
  await box.fill(text);
  await page.getByTestId('chat-panel').getByRole('button', { name: 'Send' }).click();
}

test.describe('adding a skill from the page', () => {
  test('fetches into quarantine, shows the review and approves after a confirmation', async ({ page, app }) => {
    await openSkills(page, app);
    await expect(page.getByText('No skills yet.')).toBeVisible();
    await addFromPage(page, TIDY);
    await expect(page).toHaveURL(/#\/skills\/tidy-notes$/);
    await expect(page.getByRole('heading', { name: 'tidy-notes', level: 1 })).toBeVisible();
    await expect(page.getByTestId('skill-status')).toHaveAttribute('data-status', 'quarantine');
    await expect(page.getByTestId('skill-description')).toContainText('Tidies meeting notes');
    await expect(page.getByTestId('skill-has-scripts')).toHaveText('No');
    await expect(page.getByTestId('skill-license')).toHaveText('MIT');
    await expect(page.getByTestId('skill-model')).toContainText('Nothing harmful found');
    await expect(page.getByTestId('skill-scripts-warning')).toHaveCount(0);

    // A file shows as plain text.
    const guide = page.getByTestId('skill-files-list').locator('[data-path="guide.md"]');
    await guide.getByRole('button', { name: 'Show' }).click();
    await expect(guide.getByTestId('skill-file-text')).toContainText('Keep each action to one line');

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await confirmModal(page, 'Approve');
    await expect(page.getByTestId('skill-status')).toHaveAttribute('data-status', 'approved');
    expect((await app.skills.get('tidy-notes')).record.status).toBe('approved');

    // The list, its search and its filters.
    await clickNav(page, 'Skills');
    const rows = page.getByTestId('skills').locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Status').selectOption('quarantine');
    await expect(page.getByText('No skill matches')).toBeVisible();
    await page.getByLabel('Status').selectOption('');
    await page.getByLabel('Search skills').fill('meeting');
    await expect(rows).toHaveCount(1);
  });

  test('a malicious skill shows its scripts warning, its findings and the model flag; deleting asks first', async ({ page, app }) => {
    await openSkills(page, app);
    await addFromPage(page, SYNC);
    await expect(page).toHaveURL(/#\/skills\/sync-helper$/);
    await expect(page.getByTestId('skill-scripts-warning')).toBeVisible();
    await expect(page.getByTestId('skill-network')).toHaveText('Yes');
    await expect(page.getByTestId('skill-model')).toContainText('Something looks harmful');
    await expect(page.getByTestId('skill-model')).toContainText('posts ~/.ssh/id_rsa');
    const findings = page.getByTestId('skill-findings-list');
    await expect(findings.locator('[data-rule="credentials"][data-severity="high"]').first()).toContainText('scripts/sync.sh:2');
    const script = page.getByTestId('skill-files-list').locator('[data-path="scripts/sync.sh"]');
    await script.getByRole('button', { name: 'Show' }).click();
    await expect(script.getByTestId('skill-file-text')).toContainText('curl -s -X POST');

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('skill-status')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await confirmModal(page, 'Delete');
    await expect(page).toHaveURL(/#\/skills$/);
    await expect(page.getByText('No skills yet.')).toBeVisible();
  });

  test('text aimed at the agent shows as text, never as markup', async ({ page, app }) => {
    await openSkills(page, app);
    await addFromPage(page, 'https://github.com/acme/skills/tree/main/skills/odd');
    await expect(page).toHaveURL(/#\/skills\/claude-helper$/);
    await expect(page.getByTestId('skill-findings-list').locator('[data-rule="bypass"]').first()).toContainText('Ignore all previous instructions');
    await expect(page.getByTestId('skill-findings-list').locator('[data-rule="plugin"]')).toHaveCount(1);
    const md = page.getByTestId('skill-files-list').locator('[data-path="SKILL.md"]');
    await md.getByRole('button', { name: 'Show' }).click();
    await expect(md.getByTestId('skill-file-text')).toContainText('```!');
  });

  test('a link that is not GitHub, and GitHub’s rate limit, are explained', async ({ page, app }) => {
    await openSkills(page, app);
    await addFromPage(page, 'https://gitlab.com/acme/skills');
    await expect(page.getByRole('alert')).toContainText('Only github.com links are supported.');
    app.gh.options.rateLimited = true;
    await addFromPage(page, TIDY);
    await expect(page.getByRole('alert')).toContainText('limit for requests without a token');
  });

  test('a new version: checked by hand, shown as a diff, approved after a confirmation', async ({ page, app }) => {
    await app.skills.add(TIDY);
    await app.skills.approve('tidy-notes');
    await page.goto(app.url);
    await clickNav(page, 'Skills');
    await page.getByRole('link', { name: 'tidy-notes' }).click();
    await page.getByRole('button', { name: 'Check for a new version' }).click();
    await expect(page.getByTestId('skill-check-result')).toContainText('It is up to date.');

    const repo = app.gh.repos.get('acme/skills');
    if (repo === undefined) throw new Error('no repo');
    const first = repo.refs.main as string;
    const second = fakeSha('second');
    repo.commits[second] = { files: { ...(repo.commits[first]?.files ?? {}), 'skills/tidy/guide.md': '# Guide\n\nKeep each action short.\n' } };
    repo.refs.main = second;

    await page.getByRole('button', { name: 'Check for a new version' }).click();
    const next = page.getByTestId('skill-next');
    await expect(next).toBeVisible();
    await expect(next.getByTestId('skill-diff').locator('[data-path="guide.md"]')).toHaveAttribute('data-change', 'changed');
    await expect(next.getByTestId('skill-diff').locator('[data-op="+"]')).toContainText('Keep each action short.');
    await next.getByRole('button', { name: 'Approve the new version' }).click();
    await confirmModal(page, 'Approve the new version');
    await expect(page.getByTestId('skill-next')).toHaveCount(0);
    expect((await app.skills.get('tidy-notes')).record.source.commit).toBe(second);
  });
});

test.describe('adding a skill from the chat', () => {
  test.use({
    appOptions: {
      chatScript: { turns: [[{ call: 'add_skill', args: { url: TIDY, tags: ['notes'] } }, { say: 'It is in quarantine; review it on the Skills page.' }]] },
    },
  });

  test('a card first; confirming fetches it into quarantine and links to its page', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Chat');
    await say(page, 'Add the tidy notes skill from acme/skills');
    const card = page.getByTestId('chat-card').last();
    await expect(card).toHaveAttribute('data-kind', 'addSkill');
    await expect(card.getByTestId('card-skill-url')).toHaveText(TIDY);
    expect(app.gh.requests).toEqual([]);
    await card.getByRole('button', { name: 'Confirm' }).click();
    await expect(card).toHaveAttribute('data-state', 'confirmed');
    await card.getByRole('link', { name: 'tidy-notes' }).click();
    await expect(page).toHaveURL(/#\/skills\/tidy-notes$/);
    await expect(page.getByTestId('skill-status')).toHaveAttribute('data-status', 'quarantine');
  });
});

/** A creation whose architect proposes two library skills; the generator step scaffolds and installs. */
function skillsRecording(): string {
  const spec = specInput({
    slug: 'meeting-notes',
    name: 'Meeting notes',
    agents: [{ name: 'notetaker', description: 'Takes notes.', tools: ['Read'], tier: 'light' }],
    librarySkills: [
      { name: 'tidy-notes', reason: 'Meetings leave notes to tidy.', agent: 'notetaker' },
      { name: 'sync-helper', reason: 'Keeps the notes in sync.' },
    ],
  });
  return [
    { do: 'session', phase: 'started' },
    { do: 'flow', step: 'spec', phase: 'started' },
    { do: 'label', name: 'write' },
    { do: 'hook', type: 'subagent.start', agentId: 'a3', agentType: 'architect' },
    { do: 'hook', type: 'subagent.stop', agentId: 'a3', agentType: 'architect' },
    { do: 'spec', onChange: 'write', spec: JSON.stringify(spec), summary: '# Meeting notes\n\nA workspace for meeting notes.\n' },
    { do: 'flow', step: 'spec', phase: 'finished', outcome: 'ok' },
    { do: 'flow', step: 'generate', phase: 'started' },
    { do: 'generate', dir: 'meeting-notes' },
    { do: 'flow', step: 'generate', phase: 'finished', outcome: 'ok' },
    { do: 'session', phase: 'finished', outcome: 'completed' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

test.describe('library skills in a creation', () => {
  test.use({ appOptions: { recordingText: skillsRecording() } });

  test('the approval lists them with reason and scripts warning; the one unticked is not installed', async ({ page, app }) => {
    await app.skills.add(TIDY);
    await app.skills.approve('tidy-notes');
    await app.skills.add(SYNC);
    await app.skills.approve('sync-helper');

    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A workspace for meeting notes');
    await page.getByRole('button', { name: 'Start' }).click();
    const list = page.getByTestId('spec-library-skills');
    await expect(list).toBeVisible();
    const tidy = list.locator('[data-name="tidy-notes"]');
    const sync = list.locator('[data-name="sync-helper"]');
    await expect(tidy).toContainText('Meetings leave notes to tidy.');
    await expect(tidy).toContainText('For the notetaker agent');
    await expect(sync).toContainText('Holds scripts');
    await expect(tidy.getByRole('link', { name: 'tidy-notes' })).toHaveAttribute('href', '#/skills/tidy-notes');
    await sync.getByLabel('Keep sync-helper').uncheck();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('result')).toHaveAttribute('data-outcome', 'completed', { timeout: 15_000 });

    const project = path.join(app.projectsDir, 'meeting-notes');
    await expect.poll(async () => (await readInstalled(project).catch(() => [])).map((s) => s.name)).toEqual(['tidy-notes']);
    await expect(stat(path.join(project, '.claude', 'skills', 'sync-helper'))).rejects.toThrow();
    expect(await readFile(path.join(project, '.claude', 'skills', 'tidy-notes', 'SKILL.md'), 'utf8')).toContain('name: tidy-notes');
    expect(await readFile(path.join(project, '.claude', 'agents', 'notetaker.md'), 'utf8')).toContain('skills:\n  - tidy-notes');
  });
});

test.describe('adding an approved skill to an existing project from the chat', () => {
  test.use({
    appOptions: {
      chatScript: { turns: [[{ call: 'add_skill_to_project', args: { skill: 'tidy-notes', project: 'notes' } }, { say: 'Added.' }]] },
    },
  });

  test('a card names the project and where it goes; confirming installs it and notes it', async ({ page, app }) => {
    await app.skills.add(TIDY);
    await app.skills.approve('tidy-notes');
    const dir = await recordProject(app, 'notes', 'Notes', 'sess-notes');
    await scaffold(parseSpec(specInput({ slug: 'notes' }), 'spec.json'), dir, {
      protectedDirs: [],
      templateRoots: [path.join(PACKAGE_ROOT, 'library', 'templates')],
      profiles: await loadUsageProfiles({ baseFile: baseProfilesFile() }),
      allowNonEmpty: true,
      gitInit: false,
    });

    await page.goto(app.url);
    await clickNav(page, 'Chat');
    await say(page, 'Add tidy-notes to my notes project');
    const card = page.getByTestId('chat-card').last();
    await expect(card).toHaveAttribute('data-kind', 'addSkillToProject');
    await expect(card).toContainText('Install skill tidy-notes into project notes, in .claude/skills/tidy-notes.');
    expect(await readInstalled(dir)).toEqual([]);
    await card.getByRole('button', { name: 'Confirm' }).click();
    await expect(card).toHaveAttribute('data-state', 'confirmed');
    expect((await readInstalled(dir)).map((s) => s.name)).toEqual(['tidy-notes']);
    expect(await readFile(path.join(app.libraryDir, 'projects', 'notes.md'), 'utf8')).toContain('Library skill `tidy-notes` added');
  });
});

test.describe('the plan-usage warning', () => {
  test.use({ appOptions: { usageReading: { fiveHour: 91, sevenDay: 40 } } });

  test('a start with high usage shows the values; "Not now" starts nothing, "Start anyway" starts', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'New project');
    await page.getByLabel('Describe your idea').fill('A garden planner');
    await page.getByRole('button', { name: 'Start' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Plan usage is high');
    await expect(dialog).toContainText('5-hour window 91% (warning from 80%), week 40% (warning from 85%)');
    await dialog.getByRole('button', { name: 'Not now' }).click();
    expect(app.manager.list()).toEqual([]);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start anyway' }).click();
    await expect(page).toHaveURL(/#\/new\/[0-9a-f-]{36}$/);
    expect(app.manager.list()).toHaveLength(1);
  });
});

test.describe('the plan-usage warning on a chat card', () => {
  test.use({
    appOptions: {
      usageReading: { fiveHour: 10, sevenDay: 88 },
      chatScript: { turns: [[{ call: 'start_creation', args: { idea: 'A garden planner' } }, { say: 'Proposed.' }]] },
    },
  });

  test('the start card shows the values', async ({ page, app }) => {
    await page.goto(app.url);
    await clickNav(page, 'Chat');
    await say(page, 'Start a garden planner');
    await expect(page.getByTestId('chat-card').last().getByTestId('card-usage-warning')).toContainText('week 88%');
  });
});

test.describe('archived projects', () => {
  test('archive after a confirmation; hidden from the list until shown; unarchive', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Garden planner' }).click();
    await page.getByTestId('archive-toggle').click();
    await confirmModal(page, 'Archive');
    await expect(page.getByTestId('project-archived')).toBeVisible();
    expect(await readFile(path.join(app.libraryDir, 'projects', 'garden.md'), 'utf8')).toMatch(/archived: \d{4}-\d{2}-\d{2}/);

    await clickNav(page, 'Projects');
    await expect(page.getByTestId('projects')).toHaveCount(1);
    await expect(page.getByTestId('projects').getByRole('link', { name: 'Garden planner' })).toHaveCount(0);
    await page.getByTestId('show-archived').check();
    await page.getByTestId('projects').getByRole('link', { name: 'Garden planner' }).click();
    await page.getByTestId('archive-toggle').click();
    await expect(page.getByTestId('project-archived')).toHaveCount(0);
    await clickNav(page, 'Projects');
    await expect(page.getByTestId('projects').getByRole('link', { name: 'Garden planner' })).toBeVisible();
  });
});

test.describe('discarded suggestions', () => {
  test('a discarded suggestion goes and does not come back after a reload', async ({ page, app }) => {
    const suggestions = computeSuggestions({ state: { id: 'c1', idea: 'A meal planner', sessionId: 's1', textTurns: 1, outcome: 'failed' }, lessons: [] }, new Date('2026-10-18T10:00:00Z'));
    await mkdir(path.join(app.home, 'improve'), { recursive: true });
    await writeFile(path.join(app.home, 'improve', 'suggestions.json'), JSON.stringify({ v: 1, suggestions }), 'utf8');
    await page.goto(app.url);
    await clickNav(page, 'Improvements');
    const list = page.getByTestId('suggestions').getByTestId('suggestion');
    await expect(list).toHaveCount(2);
    await list.first().getByRole('button', { name: 'Discard' }).click();
    await confirmModal(page, 'Discard');
    await expect(list).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId('suggestions').getByTestId('suggestion')).toHaveCount(1);
  });
});

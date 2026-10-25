import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS } from '../../src/chat/toolNames.js';
import { ChatToolError, findChatTool, parseArgs, resultText, type ActionTool, type ReadTool, type ToolOutcome } from '../../src/chat/tools.js';
import { FakeSafetyReviewer } from '../../src/improve/safetyReview.js';
import { computeSuggestions, SuggestionStore, type Suggestion } from '../../src/improve/suggestions.js';
import { FAKE_KEY, chatWorld, type ChatWorld } from '../chatWorld.js';
import { useHermeticGit } from '../helpers.js';
import { RESEARCHER, makeImproveRepo, openImproveWorld, researcherRound, type ImproveWorld } from '../improveWorld.js';

useHermeticGit();

describe('improvement tools of the chat', { timeout: 60_000 }, () => {
  let world: ChatWorld;
  let improve: ImproveWorld;
  let suggestion: Suggestion;

  beforeEach(async () => {
    world = await chatWorld();
    const repo = path.join(world.dir, 'improve-repo');
    await makeImproveRepo(repo);
    const store = new SuggestionStore(path.join(world.home, 'improve', 'suggestions.json'));
    suggestion = computeSuggestions({ state: { id: 'c1', idea: 'A packing list', sessionId: 's1', textTurns: 1 }, lessons: [] }, new Date('2026-10-18T10:00:00Z'))[0] as Suggestion;
    await store.add([suggestion]);
    improve = await openImproveWorld({
      repoDir: repo,
      home: world.home,
      pathEnv: world.pathEnv,
      sessionsDir: world.sessionsDir,
      libraryDir: world.libraryDir,
      projectsDir: world.projectsDir,
      script: { rounds: [researcherRound()] },
      suggestions: store,
      safety: new FakeSafetyReviewer(() => ({ weakens: true, reason: 'It softens the rule on denied calls.' })),
    });
    world.tools.improvements = () => improve.manager;
  });
  afterEach(async () => {
    await improve.manager.shutdown();
    await world.creations.shutdown();
    await world.cleanup();
  });

  const read = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const definition = findChatTool(name) as ReadTool;
    return definition.run(world.tools, parseArgs(definition, args) as never);
  };
  const propose = async (name: string, args: Record<string, unknown>) => {
    const definition = findChatTool(name) as ActionTool;
    return definition.propose(world.tools, parseArgs(definition, args) as never);
  };

  it('has three read tools and one action, and nothing that applies, discards or reverts', () => {
    expect(CHAT_READ_TOOLS).toEqual(expect.arrayContaining(['list_suggestions', 'list_proposals', 'show_proposal']));
    expect(CHAT_ACTION_TOOLS).toContain('prepare_improvement');
    for (const name of [...CHAT_READ_TOOLS, ...CHAT_ACTION_TOOLS]) expect(name).not.toMatch(/approve|apply|discard|revert/);
  });

  it('lists suggestions with their text and source', async () => {
    const listed = await read('list_suggestions');
    expect(listed.data).toEqual([expect.objectContaining({ suggestionId: suggestion.id, target: '.claude/skills/new-project/SKILL.md', text: expect.stringContaining('plain text') })]);
    expect(listed.sources).toEqual([{ kind: 'suggestion', ref: suggestion.id, label: 'A packing list' }]);
  });

  it('prepares only after the card is confirmed, then lists and shows the proposal', async () => {
    const proposal = await propose('prepare_improvement', { request: 'Ask in the browser, never in text.', suggestionId: suggestion.id, lessons: true });
    expect(proposal.card).toEqual({
      kind: 'prepareImprovement',
      request: 'Ask in the browser, never in text.',
      sessions: [],
      lessons: true,
      suggestionId: suggestion.id,
      model: 'haiku',
      effort: 'low',
    });
    // Proposing is not doing.
    expect(improve.runner.started).toHaveLength(0);
    const done = await proposal.perform();
    const id = (done.data as { proposalId: string }).proposalId;
    expect(done.sources).toEqual([{ kind: 'proposal', ref: id }]);
    expect(improve.runner.started).toHaveLength(1);
    for (let i = 0; i < 1500 && (await improve.manager.get(id)).status !== 'ready'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    const listed = await read('list_proposals');
    expect(listed.data).toMatchObject({ proposals: [{ id, status: 'ready', files: [RESEARCHER] }] });
    const shown = await read('show_proposal', { proposalId: id });
    expect(shown.data).toMatchObject({ id, status: 'ready', files: [{ path: RESEARCHER, added: 1, removed: 1 }], checks: { ok: true }, blockers: [] });
    // The safety notice reaches the chat, so it can point at it.
    expect(shown.data).toMatchObject({ safety: { state: 'flagged', reason: 'It softens the rule on denied calls.' } });
    expect(JSON.stringify(shown.data)).toContain('proposal page');
    expect(resultText(shown)).not.toContain(world.dir.replaceAll('\\', '\\\\'));
    expect((await new SuggestionStore(path.join(world.home, 'improve', 'suggestions.json')).get(suggestion.id))?.proposalId).toBe(id);
  });

  it('refuses a secret, a second session and an unknown suggestion, without a card', async () => {
    await expect(propose('prepare_improvement', { request: `key ${FAKE_KEY}` })).rejects.toBeInstanceOf(ChatToolError);
    await expect(propose('prepare_improvement', { request: 'x', suggestionId: 'sug-none' })).rejects.toThrow(/no suggestion/);
    improve.runner.script = { rounds: [{ hold: true }] };
    await improve.manager.prepare('first');
    await expect(propose('prepare_improvement', { request: 'second' })).rejects.toThrow(/already running/);
  });

  it('says so when improvements are not available', async () => {
    world.tools.improvements = undefined;
    await expect(read('list_proposals')).rejects.toThrow(/not available/);
  });
});

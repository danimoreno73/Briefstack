import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactDeep } from '../chat/tools.js';
import type { CreationState } from '../creation/manager.js';
import { readEvents, sessionEventsFile } from '../events/index.js';
import { LESSONS_FILE, readTextIfExists, toNative } from '../library/index.js';
import { addedLines } from './filters.js';
import { sessionSignals, type SessionSignals } from './signals.js';

/**
 * Suggestions after a creation (BRIEF-phase-5 §3.5): up to three short
 * pointers to what could be improved, computed from what happened, with no
 * model. A suggestion changes nothing; the user may ask for it to be
 * prepared, which starts an improvement session with it as evidence.
 */

export const MAX_SUGGESTIONS_PER_CREATION = 3;
const MAX_STORED = 60;

export type SuggestionKind = 'failure' | 'textQuestions' | 'denials' | 'reviewRounds' | 'lessons';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  creationId: string;
  sessionId?: string;
  /** The start of the idea, redacted. */
  idea: string;
  createdAt: string;
  /** The asset most likely to need the change. */
  target: string;
  /** Numbers and short texts the sentence is built from (redacted). */
  params: { count?: number; outcome?: string; steps?: string[]; tools?: string[]; lines?: string[] };
  /** Set once an improvement was prepared from it. */
  proposalId?: string;
  /** Set when the user discarded it (BRIEF-phase-6 §3.6): it is never shown again. */
  dismissedAt?: string;
}

/** The sentence a suggestion stands for, in English: what the chat and the evidence get. The page translates it itself. */
export function suggestionText(s: Pick<Suggestion, 'kind' | 'params' | 'target'>): string {
  const p = s.params;
  switch (s.kind) {
    case 'failure':
      return `The creation ended ${p.outcome ?? 'badly'}${p.steps?.length ? ` (failed steps: ${p.steps.join(', ')})` : ''}. Look at what the flow says to do there (${s.target}).`;
    case 'textQuestions':
      return `The creation ended ${p.count ?? 0} turn(s) waiting for an answer in plain text, which the web app cannot send. Make ${s.target} ask through its tools instead.`;
    case 'denials':
      return `The guard denied ${p.count ?? 0} tool call(s) (${(p.tools ?? []).join(', ')}). Make the instructions in ${s.target} avoid those calls.`;
    case 'reviewRounds':
      return `The review took ${p.count ?? 0} rounds. Make the generator get it right the first time (${s.target}).`;
    case 'lessons':
      return `The creation wrote ${p.count ?? 0} new lesson(s). Consider turning them into a general rule in ${s.target}.`;
  }
}

export interface CreationFacts {
  state: Pick<CreationState, 'id' | 'idea' | 'outcome' | 'sessionId' | 'textTurns'>;
  signals?: SessionSignals;
  /** Lines added to `lessons.md` during the creation, without date headings. */
  lessons: string[];
}

/** Up to three suggestions, the most important first. Pure. */
export function computeSuggestions(facts: CreationFacts, now: Date, homedir?: string): Suggestion[] {
  const { state, signals } = facts;
  const base = (kind: SuggestionKind, target: string, params: Suggestion['params']): Suggestion => ({
    id: `sug-${now.getTime().toString(36)}-${randomBytes(2).toString('hex')}`,
    kind,
    creationId: state.id,
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    idea: redactDeep(state.idea.slice(0, 120), homedir) as string,
    createdAt: now.toISOString(),
    target,
    params: redactDeep(params, homedir) as Suggestion['params'],
  });
  const found: Suggestion[] = [];
  const outcome = signals?.outcome ?? state.outcome;
  if (outcome === 'failed' || outcome === 'interrupted' || (signals?.failedSteps.length ?? 0) > 0) {
    found.push(base('failure', '.claude/skills/new-project/SKILL.md', { outcome: outcome ?? 'failed', steps: signals?.failedSteps ?? [] }));
  }
  if ((state.textTurns ?? 0) > 0) found.push(base('textQuestions', '.claude/skills/new-project/SKILL.md', { count: state.textTurns ?? 0 }));
  const denials = signals?.denials ?? [];
  if (denials.length > 0) {
    const agent = denials.find((d) => d.agent !== 'main')?.agent;
    found.push(base('denials', agent === undefined ? '.claude/skills/new-project/SKILL.md' : `.claude/agents/${agent}.md`, { count: denials.length, tools: [...new Set(denials.map((d) => d.tool))] }));
  }
  if ((signals?.reviewRounds ?? 0) >= 2) found.push(base('reviewRounds', '.claude/agents/generator.md', { count: signals?.reviewRounds ?? 0 }));
  if (facts.lessons.length > 0) found.push(base('lessons', '.claude/agents/interviewer.md', { count: facts.lessons.length, lines: facts.lessons.slice(0, 3).map((line) => line.slice(0, 200)) }));
  // Distinct ids even when made in the same millisecond.
  return found.slice(0, MAX_SUGGESTIONS_PER_CREATION).map((s, i) => ({ ...s, id: `${s.id}${i}` }));
}

/** The lessons a creation added: lines after it that were not there before, without date headings or blank lines. */
export function newLessons(before: string, after: string): string[] {
  return addedLines(before, after)
    .map((line) => line.text.trim())
    .filter((text) => text !== '' && !/^#{1,6}\s/.test(text));
}

/** `<home>/improve/suggestions.json`, newest first, at most 60. */
export class SuggestionStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  async list(): Promise<Suggestion[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { suggestions?: Suggestion[] };
      return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Suggestion | undefined> {
    return (await this.list()).find((s) => s.id === id);
  }

  private update(change: (list: Suggestion[]) => Suggestion[]): Promise<void> {
    const next = this.writes.then(async () => {
      const list = change(await this.list()).slice(0, MAX_STORED);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ v: 1, suggestions: list }, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  add(suggestions: readonly Suggestion[]): Promise<void> {
    return this.update((list) => [...suggestions, ...list]);
  }

  markUsed(id: string, proposalId: string): Promise<void> {
    return this.update((list) => list.map((s) => (s.id === id ? { ...s, proposalId } : s)));
  }

  /** Keeps the suggestion with `dismissedAt`, so it is known and never listed again. */
  dismiss(id: string, at: Date = new Date()): Promise<void> {
    return this.update((list) => list.map((s) => (s.id === id && s.dismissedAt === undefined ? { ...s, dismissedAt: at.toISOString() } : s)));
  }
}

/**
 * Watches creations (`CreationManager.observe`): keeps the lessons note as it
 * was at the start, and at the end computes and stores the suggestions, then
 * hands them to `announce` (the chat).
 */
export class SuggestionTracker {
  private readonly lessonsAtStart = new Map<string, Promise<string>>();

  constructor(
    private readonly deps: {
      store: SuggestionStore;
      locations: () => Promise<{ libraryDir: string; sessionsDir: string }>;
      homedir: string;
      announce?: (suggestions: Suggestion[]) => void;
      now?: () => Date;
    },
  ) {}

  private async lessons(): Promise<string> {
    const { libraryDir } = await this.deps.locations();
    return (await readTextIfExists(toNative(libraryDir, LESSONS_FILE))) ?? '';
  }

  started(state: CreationState): void {
    const reading = this.lessons().catch(() => '');
    this.lessonsAtStart.set(state.id, reading);
  }

  /** Computes, stores and announces; resolves with what was stored. */
  async finished(state: CreationState): Promise<Suggestion[]> {
    const before = (await this.lessonsAtStart.get(state.id)) ?? undefined;
    this.lessonsAtStart.delete(state.id);
    const { sessionsDir } = await this.deps.locations();
    let signals: SessionSignals | undefined;
    if (state.sessionId !== undefined) {
      try {
        signals = sessionSignals(state.sessionId, (await readEvents(sessionEventsFile(sessionsDir, state.sessionId))).events);
      } catch {
        signals = undefined;
      }
    }
    const after = before === undefined ? '' : await this.lessons().catch(() => before);
    const suggestions = computeSuggestions(
      { state, ...(signals === undefined ? {} : { signals }), lessons: before === undefined ? [] : newLessons(before, after) },
      (this.deps.now ?? (() => new Date()))(),
      this.deps.homedir,
    );
    if (suggestions.length === 0) return [];
    await this.deps.store.add(suggestions);
    this.deps.announce?.(suggestions);
    return suggestions;
  }
}

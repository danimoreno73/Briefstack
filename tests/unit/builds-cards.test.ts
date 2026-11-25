import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildManager, type BuildStartInput } from '../../src/builds/manager.js';
import { FakeBuildPlanner, PLAN_JSON_SCHEMA, plannerPrompt, validatePlanOutput } from '../../src/builds/planner.js';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import { areaPathProblem, areaProblem, areasOverlap, buildRecordSchema, MAX_SLOTS, plannerOutputSchema, queueItemSchema, type PlanOutput } from '../../src/builds/types.js';
import { startIssueFacts, uiMessages } from '../../src/i18n/ui.js';
import { afterRoundWith } from '../../src/tasks/afterRound.js';
import { TaskFakeRunner } from '../../src/tasks/fakeRunner.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { useHermeticGit } from '../helpers.js';
import { taskWorld, type TaskWorld } from '../taskWorld.js';

// Cards (BRIEF-phase-11 §2, 7 and §3; PLAN-phase-11 M1): area and size, their
// validation, the planner's schema, and builds from before phase 11.

useHermeticGit();

const CARD = { title: 'List', instruction: 'Write LIST.md.', doneWhen: 'LIST.md exists.', dependsOn: [] as number[] };

describe('a card\'s area', () => {
  it('takes relative paths with /, and refuses absolute ones, .., backslashes, wildcards and hidden characters', () => {
    for (const ok of ['src/', 'src/report/index.ts', 'docs/USAGE.md', '.', 'a b/c']) expect(areaPathProblem(ok)).toBeUndefined();
    expect(areaPathProblem('')).toBe('empty');
    expect(areaPathProblem('x'.repeat(201))).toBe('long');
    expect(areaPathProblem('/etc')).toBe('absolute');
    expect(areaPathProblem('C:/Users')).toBe('absolute');
    expect(areaPathProblem('~/notes')).toBe('absolute');
    expect(areaPathProblem('src/../..')).toBe('parent');
    expect(areaPathProblem('..')).toBe('parent');
    expect(areaPathProblem('src\\x')).toBe('chars');
    expect(areaPathProblem('src/*.ts')).toBe('chars');
    expect(areaPathProblem('src/\u202ex')).toBe('chars');
    expect(areaPathProblem('a\nb')).toBe('chars');
    // Lower-case drives, UNC paths and spaces around (review of M1, minors 4 and 7).
    expect(areaPathProblem('c:/x')).toBe('absolute');
    expect(areaPathProblem('//server/share')).toBe('absolute');
    expect(areaPathProblem(' /etc')).toBe('absolute');
    expect(areaPathProblem(' ..')).toBe('parent');
    expect(areaProblem([])).toBe('count');
    expect(areaProblem(['a', '/b'])).toBe('absolute');
    expect(areaProblem(['src/'])).toBeUndefined();
  });

  it('overlaps when a path is the same as, above or below another, without case; none or . is the whole project', () => {
    expect(areasOverlap(['src/'], ['src/report/x.ts'])).toBe(true);
    expect(areasOverlap(['src/report/x.ts'], ['src'])).toBe(true);
    expect(areasOverlap(['SRC/Report'], ['src/report/'])).toBe(true);
    expect(areasOverlap(['./docs/'], ['docs/USAGE.md'])).toBe(true);
    expect(areasOverlap(['src/report'], ['src/reporting'])).toBe(false);
    expect(areasOverlap(['src/a', 'docs/A.md'], ['src/b', 'docs/B.md'])).toBe(false);
    expect(areasOverlap(['src/a', 'docs/'], ['src/b', 'docs/B.md'])).toBe(true);
    expect(areasOverlap(['.'], ['src/b'])).toBe(true);
    expect(areasOverlap(undefined, ['src/b'])).toBe(true);
    expect(areasOverlap(['src/a'], [])).toBe(true);
    // One Unicode form; the trailing dots and spaces Windows drops (review of M1, minor 5).
    const composed = `caf${String.fromCodePoint(0xe9)}`;
    const decomposed = `cafe${String.fromCodePoint(0x301)}`;
    expect(composed).not.toBe(decomposed);
    expect(areasOverlap([`${composed}/`], [`${decomposed}/menu.md`])).toBe(true);
    expect(areasOverlap(['café/'], ['café/menu.md'])).toBe(true);
    expect(areasOverlap(['src/x.'], ['src/x/y'])).toBe(true);
    expect(areasOverlap(['src/x '], ['src/x'])).toBe(true);
  });

  it('is optional on a card, with its size; when given, both are checked', () => {
    expect(queueItemSchema.parse(CARD)).toEqual(CARD);
    expect(queueItemSchema.parse({ ...CARD, area: [' src/ '], size: 'S' })).toEqual({ ...CARD, area: ['src/'], size: 'S' });
    expect(queueItemSchema.safeParse({ ...CARD, area: [] }).success).toBe(false);
    expect(queueItemSchema.safeParse({ ...CARD, area: ['../x'] }).success).toBe(false);
    expect(queueItemSchema.safeParse({ ...CARD, area: Array.from({ length: 11 }, (_, i) => `f${i}`) }).success).toBe(false);
    expect(queueItemSchema.safeParse({ ...CARD, size: 'XL' }).success).toBe(false);
  });
});

describe('the planner\'s output', () => {
  it('asks for an area and a size on every card, in draft-07', () => {
    expect(PLAN_JSON_SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#');
    const items = (PLAN_JSON_SCHEMA as { properties: { tasks: { items: { required: string[]; properties: Record<string, Record<string, unknown>> } } } }).properties.tasks.items;
    expect(items.required).toEqual(expect.arrayContaining(['title', 'instruction', 'doneWhen', 'dependsOn', 'area', 'size']));
    expect(items.properties.size).toMatchObject({ enum: ['S', 'M', 'L'] });
    expect(items.properties.area).toMatchObject({ type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } });
    expect(plannerOutputSchema.safeParse({ tasks: [CARD], commands: [], checks: [] }).success).toBe(false);
    expect(plannerPrompt({ brief: 'x' }, 'en', 'tag')).toContain('"area": the paths or folders it is expected to change');
  });

  it('is accepted back with or without them, and checked when present', () => {
    const plan: PlanOutput = { tasks: [{ ...CARD, area: ['src/'], size: 'M' }, { ...CARD, title: 'Old', dependsOn: [1] }], commands: [], checks: [] };
    expect(validatePlanOutput(plan)).toEqual(plan);
    expect(() => validatePlanOutput({ ...plan, tasks: [{ ...CARD, area: ['/abs'] }] })).toThrow(expect.objectContaining({ code: 'build.planSchema' }));
  });
});

describe('a build record from before phase 11', () => {
  it('reads without area, size or slots', () => {
    const record = {
      v: 1,
      id: 'mhfx1a2b-abcd',
      project: 'garden',
      projectDir: '/x/garden',
      state: 'finished',
      profile: 'saver',
      model: 'sonnet',
      effort: 'low',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      branch: 'briefstack/build-mhfx1a2b-abcd',
      tasks: [{ n: 1, title: 'List', instruction: 'x', doneWhen: 'y', dependsOn: [], state: 'applied', rounds: 1 }],
      settings: { limit: 1, commands: [], checks: [], fixRounds: 1, maxRounds: 2, thresholds: { fiveHour: 80, week: 90 } },
      roundsRun: 1,
    };
    const parsed = buildRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.settings?.slots).toBeUndefined();
    expect(parsed.data?.tasks[0]?.area).toBeUndefined();
  });
});

let world: TaskWorld;

beforeEach(async () => {
  world = await taskWorld('builds-cards');
  await world.project('garden', { 'docs/BRIEF.md': '# Garden\n\n- A list.\n' });
});
afterEach(() => world.cleanup());

function managers(plan: PlanOutput): { builds: BuildManager; tasks: TaskManager } {
  const holder: { builds?: BuildManager } = {};
  const tasks = new TaskManager({
    runner: new TaskFakeRunner(),
    store: world.store,
    sessionsDir: world.sessions,
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    maxActive: () => 2,
    pollMs: 10,
    afterRound: afterRoundWith(),
    buildOn: (slug) => holder.builds?.holder(slug),
    buildDrives: (id) => holder.builds?.drives(id) ?? false,
  });
  const builds = new BuildManager({
    store: new BuildStore(buildsRoot(world.home)),
    tasks,
    planner: new FakeBuildPlanner(plan),
    locations: async () => ({ libraryDir: world.library, repoDir: world.repo }),
    lang: () => 'en',
    profile: async () => ({ name: 'saver', model: 'sonnet', effort: 'low' }),
    thresholds: async () => ({ fiveHour: 80, week: 90 }),
    maxActive: () => 2,
    slotRetryMs: 20,
  });
  holder.builds = builds;
  return { builds, tasks };
}

const PLAN: PlanOutput = {
  tasks: [
    { ...CARD, area: ['LIST.md'], size: 'S' },
    { title: 'Total', instruction: 'Write TOTAL.md.', doneWhen: 'TOTAL.md exists.', dependsOn: [], area: ['TOTAL.md'], size: 'M' },
  ],
  commands: ['npm test'],
  checks: [],
};

const startInput = (overrides: Partial<BuildStartInput> = {}): BuildStartInput => ({ tasks: PLAN.tasks, limit: 2, commands: PLAN.commands, checks: [], noChecks: true, fixRounds: 1, thresholds: { fiveHour: 80, week: 90 }, ...overrides });

describe('starting a board of cards', () => {
  it('keeps each card\'s area and size and the slots; twice the cap of rounds with more than one slot', async () => {
    const { builds, tasks } = managers(PLAN);
    try {
      const planned = await builds.plan('garden');
      await builds.idle(planned.id);
      expect((await builds.get(planned.id)).plan).toEqual(PLAN);
      const started = await builds.start(planned.id, startInput({ slots: 2 }));
      expect(started.tasks.map((task) => [task.area, task.size])).toEqual([
        [['LIST.md'], 'S'],
        [['TOTAL.md'], 'M'],
      ]);
      expect(started.settings).toMatchObject({ slots: 2, maxRounds: 8 });
      await builds.idle(planned.id);
    } finally {
      await builds.shutdown();
      await tasks.shutdown();
    }
  });

  it('without slots records none and keeps phase 9\'s cap; bad slots and bad areas are refused with their own issues', async () => {
    const { builds, tasks } = managers(PLAN);
    try {
      const planned = await builds.plan('garden');
      await builds.idle(planned.id);
      const error = (await builds.start(planned.id, startInput({ slots: MAX_SLOTS + 1, tasks: [{ ...CARD, area: ['../up'] } as never] })).catch((failure: unknown) => failure)) as {
        code: string;
        params: { items: unknown[] };
      };
      expect(error.code).toBe('build.invalidStart');
      const facts = error.params.items.map(startIssueFacts);
      // The area's own issue says what is wrong with it, not "empty or too long" (review of M1, I1).
      expect(facts.map((item) => item?.key)).toEqual(['areaInvalid', 'limit', 'slots']);
      expect(facts[0]?.area).toBe('parent');
      expect(uiMessages.en.buildStartIssue(facts[0] as NonNullable<(typeof facts)[number]>)).toBe('task 1: its area has a path that goes up with ..');
      expect(uiMessages.es.buildStartIssue(facts[0] as NonNullable<(typeof facts)[number]>)).toBe('tarea 1: su zona tiene una ruta que sube con ..');
      expect(uiMessages.en.buildStartIssue(facts[2] as NonNullable<(typeof facts)[number]>)).toBe('cards at once must be from 1 to 4');
      expect(builds.startIssues(startInput({ slots: 0 })).map((item) => item.key)).toEqual(['slots']);
      expect(builds.startIssues(startInput({ slots: 1.5 })).map((item) => item.key)).toEqual(['slots']);
      const sized = builds.startIssues(startInput({ tasks: [{ ...CARD, size: 'XL' } as never, { ...CARD, area: [] } as never, { ...CARD, title: '', area: ['C:/x'] } as never], limit: 3 }));
      expect(sized).toMatchObject([{ key: 'sizeInvalid', n: 1 }, { key: 'areaInvalid', n: 2, problem: 'count' }, { key: 'areaInvalid', n: 3, problem: 'absolute' }, { key: 'taskInvalid', n: 3, fields: ['title'] }]);
      for (const lang of ['en', 'es'] as const) {
        const said = sized.map((issue) => uiMessages[lang].buildStartIssue(startIssueFacts(issue) as NonNullable<ReturnType<typeof startIssueFacts>>));
        expect(new Set(said).size).toBe(said.length);
      }
      const started = await builds.start(planned.id, startInput());
      expect(started.settings?.slots).toBeUndefined();
      expect(started.settings?.maxRounds).toBe(4);
      await builds.idle(planned.id);
    } finally {
      await builds.shutdown();
      await tasks.shutdown();
    }
  });
});

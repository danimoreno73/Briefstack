/** Limits from the config that the browser needs too: no Node imports here. */

/** Creations that may be active at the same time when the config sets no limit (BRIEF-phase-4 §8.2). */
export const DEFAULT_MAX_ACTIVE_CREATIONS = 2;
/** Plan usage (percent) above which starting a creation or an improvement shows a warning (BRIEF-phase-6 §3.6). */
export const DEFAULT_USAGE_WARN_FIVE_HOUR = 80;
export const DEFAULT_USAGE_WARN_WEEK = 85;
/** Above this, Settings notes that plan usage adds up quickly. */
export const MANY_CREATIONS_NOTE_ABOVE = 3;

/**
 * The implement step's bounds (BRIEF-phase-10 §2, 9; PLAN-phase-10 §1, 7):
 * settings, with conservative defaults. Turns are the implementer's tool
 * calls, counted by the server.
 */
export const DEFAULT_IMPLEMENT_MINUTES = 30;
export const MIN_IMPLEMENT_MINUTES = 5;
export const MAX_IMPLEMENT_MINUTES = 120;
export const DEFAULT_IMPLEMENT_TOOL_CALLS = 150;
export const MIN_IMPLEMENT_TOOL_CALLS = 20;
export const MAX_IMPLEMENT_TOOL_CALLS = 1000;

const wholeIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const isImplementMinutes = (value: unknown): value is number => wholeIn(value, MIN_IMPLEMENT_MINUTES, MAX_IMPLEMENT_MINUTES);
export const isImplementToolCalls = (value: unknown): value is number => wholeIn(value, MIN_IMPLEMENT_TOOL_CALLS, MAX_IMPLEMENT_TOOL_CALLS);
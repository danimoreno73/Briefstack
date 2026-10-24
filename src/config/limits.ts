/** Limits from the config that the browser needs too: no Node imports here. */

/** Creations that may be active at the same time when the config sets no limit (BRIEF-phase-4 §8.2). */
export const DEFAULT_MAX_ACTIVE_CREATIONS = 2;
/** Plan usage (percent) above which starting a creation or an improvement shows a warning (BRIEF-phase-6 §3.6). */
export const DEFAULT_USAGE_WARN_FIVE_HOUR = 80;
export const DEFAULT_USAGE_WARN_WEEK = 85;
/** Above this, Settings notes that plan usage adds up quickly. */
export const MANY_CREATIONS_NOTE_ABOVE = 3;
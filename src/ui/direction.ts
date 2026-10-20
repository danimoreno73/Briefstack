/**
 * Development only (UI pass, step U1): picks one of the two design directions
 * under review (docs/DESIGN.md §2) from `localStorage['briefstack-direction']`
 * (`a` or `b`). Without the key nothing changes. Set it from the browser's
 * console; U2 removes this flag with the direction that is not chosen.
 */
export const DIRECTION_KEY = 'briefstack-direction';

export function applyDevDirection(): void {
  let value: string | null = null;
  try {
    value = localStorage.getItem(DIRECTION_KEY);
  } catch {
    // Storage may be unavailable; the current look stays.
  }
  if (value === 'a' || value === 'b') document.documentElement.dataset.direction = value;
}

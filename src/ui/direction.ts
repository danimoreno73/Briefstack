/**
 * Development only (UI pass, steps U1 and U1b): picks one of the two design
 * directions under review (docs/DESIGN.md §2) from
 * `localStorage['briefstack-direction']` (`a` or `b`), and for direction A
 * one of its three type variants from `localStorage['briefstack-type']`
 * (`1`, `2` or `3`). Without the keys nothing changes. Set them from the
 * browser's console; U2 removes this flag with what is not chosen.
 */
export const DIRECTION_KEY = 'briefstack-direction';
export const TYPE_KEY = 'briefstack-type';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage may be unavailable; the current look stays.
    return null;
  }
}

export function applyDevDirection(): void {
  const direction = stored(DIRECTION_KEY);
  if (direction !== 'a' && direction !== 'b') return;
  document.documentElement.dataset.direction = direction;
  const type = stored(TYPE_KEY);
  if (direction === 'a' && (type === '1' || type === '2' || type === '3')) document.documentElement.dataset.type = type;
}

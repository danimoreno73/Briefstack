/**
 * The theme switch: `system` (the default) follows the operating system;
 * `light` and `dark` fix it. bs.css changes its tokens only through
 * `<html data-theme>`, so the attribute always holds the theme in use: for
 * `system` it is read from `prefers-color-scheme` and kept current when that
 * changes. The choice is kept per browser in localStorage.
 */
import { isTheme, resolveTheme, type Theme } from './themeChoice.js';

export { THEMES, type Theme } from './themeChoice.js';

const KEY = 'briefstack-theme';

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

const darkQuery = (): MediaQueryList | undefined => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined);

let current: Theme = 'system';
let following = false;

function paint(): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(current, darkQuery()?.matches === true);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta !== null) meta.content = getComputedStyle(root).backgroundColor;
}

/** Sets the theme on the page and the browser's bar colour; `store` keeps it for the next visit. */
export function applyTheme(theme: Theme, store = false): void {
  current = theme;
  if (!following) {
    // Once per page: while the choice is `system`, a change of the system's theme repaints.
    darkQuery()?.addEventListener('change', () => {
      if (current === 'system') paint();
    });
    following = true;
  }
  paint();
  if (!store) return;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be unavailable; the theme still applies to this page.
  }
}

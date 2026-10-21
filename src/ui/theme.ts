/**
 * The theme switch: `system` (the default) follows the operating system;
 * `light` and `dark` set `<html data-theme>`, which tokens.css turns into
 * `color-scheme`. The choice is kept per browser in localStorage.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

const KEY = 'briefstack-theme';

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Sets the theme on the page and the browser's bar colour; `store` keeps it for the next visit. */
export function applyTheme(theme: Theme, store = false): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta !== null) meta.content = getComputedStyle(document.body).backgroundColor;
  if (!store) return;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be unavailable; the theme still applies to this page.
  }
}

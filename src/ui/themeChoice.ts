/** The theme choices and how `system` resolves. Pure, so it is tested without a browser; theme.ts applies it. */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The theme the page shows for a choice: `system` resolves to the operating system's. */
export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return prefersDark ? 'dark' : 'light';
}

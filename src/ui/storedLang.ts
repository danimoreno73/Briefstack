import { isLang, type Lang } from '../i18n/index.js';

const KEY = 'briefstack-lang';

/** The language the server last reported, so a reload does not start in the browser's own language. */
export function readStoredLang(): Lang | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return isLang(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Storage may be unavailable; the server still has the setting.
  }
}

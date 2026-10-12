/** Every user-facing string lives under `src/i18n/`, one module per area. */

export const LANGS = ['en', 'es'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'en';

/** A catalogue with the same shape in every language. */
export type Catalogue<T> = Record<Lang, T>;

export function defineCatalogue<T>(catalogue: Catalogue<T>): Catalogue<T> {
  return catalogue;
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Maps a locale such as `es_ES.UTF-8` or `es-MX` to a supported language. */
export function langFromLocale(locale: string | undefined): Lang | undefined {
  if (locale === undefined) return undefined;
  const primary = locale.trim().toLowerCase().split(/[-_.@]/)[0];
  return isLang(primary) ? primary : undefined;
}

export interface LangSources {
  env: Readonly<Record<string, string | undefined>>;
  configLang?: string | undefined;
  /** OS locale, e.g. from `Intl.DateTimeFormat().resolvedOptions().locale`. */
  osLocale?: string | undefined;
}

/** `BRIEFSTACK_LANG` > config > OS locale > `en`. Unknown values are skipped. */
export function resolveLang(sources: LangSources): Lang {
  const { env } = sources;
  const fromEnv = env.BRIEFSTACK_LANG?.trim().toLowerCase();
  if (isLang(fromEnv)) return fromEnv;
  if (isLang(sources.configLang)) return sources.configLang;
  const posixLocale = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  return langFromLocale(posixLocale) ?? langFromLocale(sources.osLocale) ?? DEFAULT_LANG;
}

export function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

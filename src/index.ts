import { readFileSync } from 'node:fs';

/** Public API. Kept importable so a web server can call it in phase 2. */

interface PackageJson {
  version: string;
}

// `src/` and `dist/` are both one level below the package root.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

export const VERSION: string = packageJson.version;

export * from './config/index.js';
export * from './errors.js';
export * from './frontmatter/index.js';
export { DEFAULT_LANG, LANGS, isLang, resolveLang, systemLocale, type Lang } from './i18n/index.js';
export { formatError } from './i18n/errors.js';
export * from './scaffold/index.js';
export * from './spec/index.js';
export * from './models.js';
export * from './usage/index.js';
export * from './validate/index.js';
export { formatFinding, formatFindingMessage } from './i18n/validate.js';
export { PACKAGE_ROOT } from './packageRoot.js';

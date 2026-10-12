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

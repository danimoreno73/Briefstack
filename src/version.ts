import { readFileSync } from 'node:fs';

interface PackageJson {
  version: string;
}

// `src/` and `dist/` are both one level below the package root.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

export const VERSION: string = packageJson.version;

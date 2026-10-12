import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The briefstack package (the repo when run from source). `src/` and `dist/` sit one level below it. */
export const PACKAGE_ROOT: string = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

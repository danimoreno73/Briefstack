// Copies the UI's static files (index.html, css) next to the compiled UI in
// dist/web. Runs after `tsc -p tsconfig.ui.json` in `npm run build`.

import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
cpSync(path.join(root, 'src', 'ui', 'static'), path.join(root, 'dist', 'web'), { recursive: true });

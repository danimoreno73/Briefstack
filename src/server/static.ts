import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPathInside } from '../config/paths.js';
import { BriefstackError } from '../errors.js';
import { PACKAGE_ROOT } from '../packageRoot.js';

/** Built UI: `tsc -p tsconfig.ui.json` plus `src/ui/static/` copied in. */
export function defaultUiDir(): string {
  return path.join(PACKAGE_ROOT, 'dist', 'web');
}

/** Bare specifiers in the compiled UI, mapped by the import map to these URLs. */
const VENDOR: Readonly<Record<string, string>> = {
  preact: '/vendor/preact.mjs',
  'preact/hooks': '/vendor/preact-hooks.mjs',
  'preact/jsx-runtime': '/vendor/preact-jsx-runtime.mjs',
  'markdown-it': '/vendor/markdown-it.mjs',
};

/** Where a vendored module is resolved from, when that is not its own specifier (a self-contained browser build). */
const VENDOR_SOURCE: Readonly<Record<string, string>> = { 'markdown-it': 'markdown-it/browser' };

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Placeholder in `index.html` replaced by the import map. */
const IMPORT_MAP_SLOT = '<!-- importmap -->';

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

export interface StaticSite {
  /** `undefined` when the path is not served (missing, outside the root, unknown type). */
  get(urlPath: string): Promise<StaticFile | undefined>;
  /** Content-Security-Policy for every response, with the import map's hash. */
  csp: string;
}

/**
 * Serves the built UI and the vendored Preact modules. Only files under the
 * UI folder with a known extension are served, plus the vendor files listed
 * above, so a crafted path cannot reach anything else.
 */
export async function loadStaticSite(uiDir: string = defaultUiDir()): Promise<StaticSite> {
  const indexFile = path.join(uiDir, 'index.html');
  let template: string;
  try {
    template = await readFile(indexFile, 'utf8');
  } catch {
    throw new BriefstackError('web.uiNotBuilt', { dir: uiDir });
  }
  const importMap = `<script type="importmap">${JSON.stringify({ imports: VENDOR })}</script>`;
  const scriptHash = createHash('sha256')
    .update(importMap.slice('<script type="importmap">'.length, -'</script>'.length))
    .digest('base64');
  const index = Buffer.from(template.replace(IMPORT_MAP_SLOT, importMap), 'utf8');
  const vendorFiles = new Map<string, string>(
    Object.entries(VENDOR).map(([specifier, url]) => [url, fileURLToPath(import.meta.resolve(VENDOR_SOURCE[specifier] ?? specifier))]),
  );
  const root = path.resolve(uiDir);

  async function get(urlPath: string): Promise<StaticFile | undefined> {
    if (urlPath === '/' || urlPath === '/index.html') return { body: index, contentType: CONTENT_TYPES['.html'] as string };
    const vendor = vendorFiles.get(urlPath);
    if (vendor !== undefined) return { body: await readFile(vendor), contentType: CONTENT_TYPES['.mjs'] as string };

    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return undefined;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
    const file = path.resolve(root, ...decoded.split('/').filter((part) => part !== ''));
    // The file is built from root, so an exact (case-sensitive) prefix check is enough.
    if (!isPathInside(file, root, { pathApi: path, caseInsensitive: false })) return undefined;
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (contentType === undefined) return undefined;
    try {
      if (!(await stat(file)).isFile()) return undefined;
      return { body: await readFile(file), contentType };
    } catch {
      return undefined;
    }
  }

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${scriptHash}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return { get, csp };
}

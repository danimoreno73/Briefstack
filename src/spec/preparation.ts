/**
 * briefstack prepares a project; it does not do the project's work (H9
 * rehearsal, run A). A spec may only ask for documents, and a generated
 * project must contain no application code or build files outside `.claude/`
 * and `.briefstack/`. One list for both checks.
 */

/** Extensions a file listed in a spec may have. */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['.md', '.txt', '.csv'];

/** Source code, scripts and notebooks. Lower case, with the dot. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  '.bash', '.bat', '.c', '.cc', '.cjs', '.clj', '.cmd', '.cpp', '.cs', '.cxx', '.dart', '.ex', '.exs',
  '.fs', '.go', '.h', '.hpp', '.hs', '.ipynb', '.java', '.jl', '.js', '.jsx', '.kt', '.kts', '.lua',
  '.m', '.mjs', '.php', '.pl', '.ps1', '.psm1', '.py', '.r', '.rb', '.rs', '.scala', '.sh', '.sql',
  '.svelte', '.swift', '.ts', '.tsx', '.vb', '.vue', '.zsh',
];

/** Package manifests, lock files and build files. Lower case. */
export const BUILD_FILES: readonly string[] = [
  'build.gradle', 'build.gradle.kts', 'cargo.lock', 'cargo.toml', 'cmakelists.txt', 'composer.json',
  'dockerfile', 'gemfile', 'go.mod', 'go.sum', 'makefile', 'package-lock.json', 'package.json',
  'pipfile', 'pnpm-lock.yaml', 'pom.xml', 'pyproject.toml', 'requirements.txt', 'setup.cfg',
  'tsconfig.json', 'uv.lock', 'yarn.lock',
];

export type ApplicationFileKind = 'source' | 'buildFile';

const baseName = (relativePath: string): string => (relativePath.split('/').pop() ?? '').toLowerCase();

const extension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
};

/** Whether a relative path (with `/`) is application code or a build file, and which. */
export function applicationFileKind(relativePath: string): ApplicationFileKind | undefined {
  const name = baseName(relativePath);
  if (BUILD_FILES.includes(name)) return 'buildFile';
  if (SOURCE_EXTENSIONS.includes(extension(name))) return 'source';
  return undefined;
}

/** Whether a spec may list this file: a document, and not a build file such as `requirements.txt`. */
export function isDocumentPath(relativePath: string): boolean {
  return DOCUMENT_EXTENSIONS.includes(extension(baseName(relativePath))) && applicationFileKind(relativePath) === undefined;
}

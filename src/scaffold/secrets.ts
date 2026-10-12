/**
 * Secret locations for generated projects (`decisions.md` §8 and "Secret
 * env files"). One list feeds both the deny rules and `.gitignore`.
 */

/**
 * `.env` files that hold real values. Deliberately narrow: documentation
 * files such as `.env.example` and `.env.sample` must stay readable, and a
 * deny rule cannot be undone by an allow rule.
 */
export const SECRET_ENV_FILES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.*.local',
  '.env.development',
  '.env.production',
  '.env.staging',
];

const SECRET_FILE_GLOBS: readonly string[] = ['*.pem', '*.key'];

const HOME_SECRETS: readonly string[] = [
  '~/.ssh/**',
  '~/.aws/**',
  '~/.azure/**',
  '~/.config/gcloud/**',
  '~/.npmrc',
  '~/.netrc',
];

/** A Read deny also blocks Edit and Write on the same path. */
export const DENY_RULES: readonly string[] = [
  ...SECRET_ENV_FILES.map((name) => `Read(${name})`),
  ...SECRET_FILE_GLOBS.map((glob) => `Read(**/${glob})`),
  ...HOME_SECRETS.map((pattern) => `Read(${pattern})`),
];

export const SECRET_GITIGNORE_LINES: readonly string[] = [...SECRET_ENV_FILES, ...SECRET_FILE_GLOBS];

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

/**
 * Whether a `Read(...)` rule denies a path inside the project, for the
 * subset of the rule syntax used in `DENY_RULES`: bare names and `**\/name`
 * match a file name at any depth (gitignore semantics), `*` stays within one
 * segment. Home (`~/`) and absolute (`//`) rules never match project paths.
 * This models Claude Code's matcher; `decisions.md` records a real probe.
 */
export function readRuleDenies(rule: string, projectPath: string): boolean {
  const match = /^Read\((.+)\)$/.exec(rule);
  const pattern = match?.[1];
  if (pattern === undefined || pattern.startsWith('~/') || pattern.startsWith('//')) return false;

  const name = pattern.startsWith('**/') ? pattern.slice(3) : pattern;
  if (name.includes('/')) return false;
  const fileName = projectPath.slice(projectPath.lastIndexOf('/') + 1);
  return globToRegExp(name).test(fileName);
}

export function isReadDenied(projectPath: string, rules: readonly string[] = DENY_RULES): boolean {
  return rules.some((rule) => readRuleDenies(rule, projectPath));
}

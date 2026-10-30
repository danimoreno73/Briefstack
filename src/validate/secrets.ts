/**
 * Secret detection on one line. A module with no imports, so the browser UI
 * can use it too: the same check hides secrets on the server and in the page.
 */

/** Kinds of secret-looking strings `validate` recognises. */
export const SECRET_KINDS = [
  'privateKey',
  'anthropic',
  'openai',
  'aws',
  'github',
  'slack',
  'google',
  'stripe',
  'assignment',
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

interface SecretPattern {
  kind: SecretKind;
  re: RegExp;
  /** Extra check on the captured value (group 1, or the whole match). */
  accept?: (value: string) => boolean;
}

const PLACEHOLDER =
  /x{4,}|\*{3,}|\.{3}|<|>|\$\{|\{\{|\$\(|your|example|placeholder|changeme|change_me|dummy|sample|redacted|replace|insert|fake|todo/i;

/** A credential-like value: long, mixed letters and digits, varied, not a placeholder. */
export function looksRandom(value: string): boolean {
  if (value.length < 20 || /\s/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  return new Set(value).size >= 10;
}

const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|secret|token)';

/** High-signal patterns only; generic assignments must also look random. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'privateKey', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  {
    kind: 'aws',
    re: /(?<![A-Z0-9])((?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Z0-9])/,
    accept: (value) => !value.endsWith('EXAMPLE'),
  },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { kind: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { kind: 'stripe', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}/ },
  {
    // `api_key = "..."`, `"apiKey": "..."`, `password: '...'`
    kind: 'assignment',
    re: new RegExp(`${SECRET_NAME}["']?\\s*[:=]\\s*["']([^"'\\s]+)["']`, 'i'),
    accept: looksRandom,
  },
  {
    // `.env` style: `OPENAI_API_KEY=...` without quotes.
    kind: 'assignment',
    re: /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*([^\s"'#]+)/,
    accept: looksRandom,
  },
];

/** Kinds of secret-looking strings on one line, each reported once. */
export function findSecrets(line: string): SecretKind[] {
  const kinds: SecretKind[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (kinds.includes(pattern.kind)) continue;
    const match = pattern.re.exec(line);
    if (match === null) continue;
    const value = match[1] ?? match[0];
    if (pattern.accept === undefined || pattern.accept(value)) kinds.push(pattern.kind);
  }
  return kinds;
}

/** What replaces a line that looks like a secret, on the server and in the UI. */
export const REDACTED_LINE = '[redacted]';

/** What replaces only the secret value in a line `maskSecretValues` can still show. */
export const SECRET_MASK = '[secret]';

/** A value made only of the characters credentials use: masking it hides nothing else. */
const MASKABLE = /^[A-Za-z0-9_\-+/=.]+$/;

/**
 * The line with each secret-looking value replaced by `[secret]`, so the
 * rest of it stays readable (a diff the user approves must show what it
 * changes). A value holding any other character could carry code, so it is
 * not masked; a line that still looks like a secret after masking is
 * replaced whole, as `redactSecretLines` does.
 */
export function maskSecretValues(line: string): string {
  let out = line;
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    out = out.replace(re, (...args: unknown[]) => {
      const match = String(args[0]);
      const group = typeof args[1] === 'string' ? args[1] : undefined;
      const value = group ?? match;
      if (pattern.accept !== undefined && !pattern.accept(value)) return match;
      if (pattern.kind !== 'privateKey' && !MASKABLE.test(value)) return match;
      return group === undefined ? SECRET_MASK : match.replace(group, SECRET_MASK);
    });
  }
  return findSecrets(out).length > 0 ? REDACTED_LINE : out;
}

/** Replaces every line that looks like a secret; the rest of the text is untouched. */
export function redactSecretLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (findSecrets(line).length > 0 ? REDACTED_LINE : line))
    .join('\n');
}


import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { findSecrets, redactSecretLines } from '../validate/secrets.js';

/**
 * The static review of a skill in quarantine (BRIEF-phase-6 §3.3). Pure:
 * it reads the fetched bytes and runs nothing. Each finding names a file,
 * a line when there is one, a rule and a severity. Findings inform the
 * user; none blocks, and the user approves after seeing the code.
 */

export type FileKind = 'markdown' | 'script' | 'binary' | 'other';
export type Severity = 'high' | 'medium' | 'low' | 'info';

export const FINDING_RULES = [
  'script',
  'binary',
  'network',
  'shell',
  'injectedCommand',
  'deletion',
  'writeOutside',
  'credentials',
  'obfuscation',
  'hooks',
  'settings',
  'plugin',
  'allowedTools',
  'bypass',
  'secret',
  'license',
  'frontmatter',
  'appName',
  'appDescription',
  'truncated',
  'encoding',
  'portability',
] as const;
export type FindingRule = (typeof FINDING_RULES)[number];

export interface ReviewFinding {
  rule: FindingRule;
  severity: Severity;
  /** Relative to the skill folder, with `/`; empty for the skill as a whole. */
  file: string;
  line?: number;
  /** The line, cut to 160 characters, secrets hidden. */
  excerpt?: string;
}

export interface InventoryItem {
  path: string;
  size: number;
  sha256: string;
  kind: FileKind;
  executable: boolean;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** As written: a string or a list joined with spaces. */
  allowedTools?: string;
  license?: string;
  hooks: boolean;
  shell?: string;
  disableModelInvocation: boolean;
  /** `false` when SKILL.md has no frontmatter or it does not parse. */
  parsed: boolean;
}

export interface LicenseInfo {
  /** An SPDX id, or `null` when none was recognised. */
  spdx: string | null;
  /** Where it came from. */
  source: 'file' | 'frontmatter' | 'header' | 'repo' | 'none';
  /** The license file (in the skill, or at the repo root for `repo`). */
  file?: string;
}

export interface StaticReview {
  inventory: InventoryItem[];
  frontmatter: SkillFrontmatter;
  license: LicenseInfo;
  findings: ReviewFinding[];
  hasScripts: boolean;
  network: boolean;
}

export interface ReviewInput {
  files: readonly { path: string; bytes: Buffer; executable: boolean }[];
  rootLicense?: { path: string; bytes: Buffer } | undefined;
}

export const MAX_FINDINGS = 200;
/** The byte order mark some editors put at the start of a text file. */
const BOM = String.fromCharCode(0xfeff);
const MAX_EXCERPT = 160;

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
const SCRIPT_EXT = new Set([
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'vbs', 'wsf', 'py', 'pyw', 'js', 'mjs', 'cjs', 'jsx', 'ts',
  'mts', 'cts', 'tsx', 'rb', 'pl', 'pm', 'php', 'lua', 'r', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'fsx', 'scala', 'groovy',
  'applescript', 'scpt', 'awk', 'tcl', 'ahk', 'nu', 'jl', 'dart', 'ex', 'exs',
]);
/** Binaries that run as code; any other binary (an image, a font) is only noted. */
const EXECUTABLE_BINARY_EXT = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'com', 'msi', 'jar', 'class', 'wasm', 'pyc', 'pyo', 'node', 'elf', 'app', 'apk', 'deb', 'rpm', 'dmg', 'pkg']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
/** Pages and images that may carry JavaScript. */
const PAGE_EXT = new Set(['html', 'htm', 'xhtml', 'svg']);
const EMBEDDED_SCRIPT = /<script\b|\son[a-z]+\s*=|javascript:/i;
const MAKEFILE_NAME = /^(?:gnu)?makefile$|\.mk$/i;

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isBinary(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8000).includes(0)) return true;
  // Not valid UTF-8 is not text we can read line by line.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin1';

/**
 * The text of a file however it is encoded: UTF-8, UTF-16 (with a byte
 * order mark, or without one when most bytes on one side are zero), and
 * latin-1 for anything else, which never fails. A script that is not UTF-8
 * still runs (PowerShell reads UTF-16, Python honours a coding line), so the
 * review reads it this way instead of calling it binary.
 */
export function decodeText(bytes: Buffer): { text: string; encoding: TextEncoding } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: swapBytes(bytes.subarray(2)).toString('utf16le'), encoding: 'utf-16be' };
  const sample = bytes.subarray(0, 8000);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const half = sample.length / 2;
  if (half >= 1 && oddZeros >= half * 0.4 && evenZeros <= oddZeros / 8) return { text: bytes.toString('utf16le'), encoding: 'utf-16le' };
  if (half >= 1 && evenZeros >= half * 0.4 && oddZeros <= evenZeros / 8) return { text: swapBytes(bytes).toString('utf16le'), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: bytes.toString('latin1'), encoding: 'latin1' };
  }
}

function swapBytes(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1] as number;
    out[i + 1] = bytes[i] as number;
  }
  return out;
}

/** A `package.json` with at least one entry under `scripts` (npm runs them on install or on request). */
function hasPackageScripts(bytes: Buffer): boolean {
  const source = bytes.toString('utf8');
  try {
    const data = JSON.parse(source) as { scripts?: unknown };
    if (typeof data.scripts === 'object' && data.scripts !== null && Object.keys(data.scripts).length > 0) return true;
  } catch {
    // Not JSON npm can read; look at the text below.
  }
  return /"scripts"\s*:\s*\{\s*"/.test(source);
}

/**
 * What a file is. The name decides first: a known script extension, a
 * shebang or a Makefile is a script even when its bytes do not look like
 * UTF-8 text. Then package.json with scripts and pages or SVG images with
 * JavaScript count as scripts too.
 */
export function fileKind(path: string, bytes: Buffer, executable: boolean): FileKind {
  const ext = extensionOf(path);
  const name = baseName(path);
  if (EXECUTABLE_BINARY_EXT.has(ext)) return 'binary';
  if (SCRIPT_EXT.has(ext) || MAKEFILE_NAME.test(name) || bytes.subarray(0, 2).toString('latin1') === '#!') return 'script';
  const binary = isBinary(bytes);
  if (executable) return binary ? 'binary' : 'script';
  if (binary) return 'binary';
  if (name.toLowerCase() === 'package.json' && hasPackageScripts(bytes)) return 'script';
  if (PAGE_EXT.has(ext) && EMBEDDED_SCRIPT.test(bytes.toString('utf8'))) return 'script';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  return 'other';
}

export function inventory(files: ReviewInput['files']): InventoryItem[] {
  return files
    .map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes), kind: fileKind(file.path, file.bytes, file.executable), executable: file.executable }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined);

/** The fields of SKILL.md's frontmatter the review cares about. Never throws. */
export function readSkillFrontmatter(source: string): SkillFrontmatter {
  const empty: SkillFrontmatter = { hooks: false, disableModelInvocation: false, parsed: false };
  const normalised = source.startsWith(BOM) ? source.slice(1) : source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalised);
  if (match === null) return empty;
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '', { maxAliasCount: 10 });
  } catch {
    return empty;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return empty;
  const record = data as Record<string, unknown>;
  const tools = record['allowed-tools'];
  const out: SkillFrontmatter = {
    hooks: record.hooks !== undefined && record.hooks !== null,
    disableModelInvocation: record['disable-model-invocation'] === true || record['disable-model-invocation'] === 'true',
    parsed: true,
  };
  const name = text(record.name);
  if (name !== undefined) out.name = name.trim();
  const description = text(record.description);
  if (description !== undefined) out.description = description.trim();
  if (Array.isArray(tools)) out.allowedTools = tools.map((t) => text(t) ?? '').filter((t) => t !== '').join(' ');
  else if (text(tools) !== undefined) out.allowedTools = (text(tools) as string).trim();
  const license = text(record.license);
  if (license !== undefined) out.license = license.trim();
  const shell = text(record.shell);
  if (shell !== undefined) out.shell = shell.trim();
  return out;
}

// --- License -------------------------------------------------------------

const LICENSE_FILE = /^(?:licen[cs]e|copying|unlicense)(?:[-._][a-z0-9.-]*)?$/i;

const SPDX_IDS = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only',
  'GPL-3.0-or-later', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'AGPL-3.0',
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'MPL-2.0', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', '0BSD', 'Zlib', 'BSL-1.0',
  'EPL-2.0', 'WTFPL',
]);

/** The SPDX id a license text is, by phrases each license has; `null` when unknown. */
export function identifyLicense(body: string): string | null {
  const t = body.replace(/\s+/g, ' ');
  const has = (phrase: string | RegExp) => (typeof phrase === 'string' ? t.toLowerCase().includes(phrase.toLowerCase()) : phrase.test(t));
  if (has('GNU AFFERO GENERAL PUBLIC LICENSE')) return 'AGPL-3.0';
  if (has('GNU LESSER GENERAL PUBLIC LICENSE')) return has(/Version 2\.1/i) ? 'LGPL-2.1' : 'LGPL-3.0';
  if (has('GNU GENERAL PUBLIC LICENSE')) return has(/Version 2,/i) ? 'GPL-2.0' : 'GPL-3.0';
  if (has('Mozilla Public License Version 2.0') || has('Mozilla Public License, v. 2.0')) return 'MPL-2.0';
  if (has('Apache License') && has(/Version 2\.0/i)) return 'Apache-2.0';
  if (has('This is free and unencumbered software released into the public domain')) return 'Unlicense';
  if (has('CC0 1.0 Universal')) return 'CC0-1.0';
  if (has('Attribution-ShareAlike 4.0 International')) return 'CC-BY-SA-4.0';
  if (has('Attribution 4.0 International')) return 'CC-BY-4.0';
  if (has('Boost Software License - Version 1.0')) return 'BSL-1.0';
  if (has('Eclipse Public License - v 2.0')) return 'EPL-2.0';
  if (has('Permission is hereby granted, free of charge, to any person obtaining a copy')) return 'MIT';
  if (has('Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee')) {
    return has('THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS') && !has('copyright notice and this permission notice appear') ? '0BSD' : 'ISC';
  }
  if (has('Redistribution and use in source and binary forms')) return has('Neither the name') ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (has("This software is provided 'as-is', without any express or implied warranty")) return 'Zlib';
  if (has('DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE')) return 'WTFPL';
  return null;
}

const SPDX_HEADER = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/;

function spdxOf(value: string): string | null {
  const trimmed = value.trim();
  const found = [...SPDX_IDS].find((id) => id.toLowerCase() === trimmed.toLowerCase());
  return found ?? null;
}

export function detectLicense(files: ReviewInput['files'], frontmatter: SkillFrontmatter, rootLicense?: ReviewInput['rootLicense']): LicenseInfo {
  const licenseFiles = files.filter((file) => LICENSE_FILE.test(baseName(file.path))).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const file of licenseFiles) {
    const spdx = identifyLicense(file.bytes.toString('utf8'));
    if (spdx !== null) return { spdx, source: 'file', file: file.path };
  }
  if (frontmatter.license !== undefined) {
    const spdx = spdxOf(frontmatter.license);
    if (spdx !== null) return { spdx, source: 'frontmatter' };
  }
  for (const file of files) {
    const match = SPDX_HEADER.exec(file.bytes.subarray(0, 4096).toString('utf8'));
    const spdx = match === null ? null : spdxOf(match[1] ?? '');
    if (spdx !== null) return { spdx, source: 'header', file: file.path };
  }
  if (licenseFiles.length > 0) return { spdx: null, source: 'file', file: (licenseFiles[0] as { path: string }).path };
  if (rootLicense !== undefined) {
    return { spdx: identifyLicense(rootLicense.bytes.toString('utf8')), source: 'repo', file: rootLicense.path };
  }
  return { spdx: null, source: 'none' };
}

// --- Static rules --------------------------------------------------------

interface LineContext {
  kind: FileKind;
  path: string;
  line: string;
}

interface LineRule {
  rule: FindingRule;
  /**
   * `weighed`: decided by the rest of the file once it is read, `medium`
   * when the file shows another sign of risk, `low` otherwise.
   */
  severity: Severity | 'weighed' | ((context: LineContext) => Severity);
  pattern: RegExp;
  /** Which file kinds it applies to; all text kinds by default. */
  kinds?: readonly FileKind[];
}

const inScript = (high: Severity, other: Severity) => (context: LineContext) => (context.kind === 'script' ? high : other);

const URL_PATTERN = /\b(?:https?|ftp|wss?):\/\/[^\s)>"'`]+/gi;
/** The host of a URL, lower case, with the brackets of an IPv6 address. */
const urlHost = (url: string): string => /^[a-z]+:\/\/(?:[^@/\s]*@)?(\[[^\]]*\]|[^:/\s?#]*)/i.exec(url)?.[1]?.toLowerCase() ?? '';
const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0' || host === '[::1]' || host === '[::]';

/**
 * A URL is `info` in a license file, or when every URL on the line points
 * to this machine; otherwise `medium` in a script and `low` elsewhere.
 */
function urlSeverity(context: LineContext): Severity {
  if (LICENSE_FILE.test(baseName(context.path))) return 'info';
  const hosts = (context.line.match(URL_PATTERN) ?? []).map(urlHost);
  if (hosts.length > 0 && hosts.every(isLocalHost)) return 'info';
  return context.kind === 'script' ? 'medium' : 'low';
}

/** Line rules, in the order findings are listed for a line. One finding per rule per line. */
const LINE_RULES: readonly LineRule[] = [
  // Instructions aimed at the agent to drop its rules or the user's control.
  {
    rule: 'bypass',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|system|safety|the user'?s?)\b[^.\n]{0,30}\b(?:instructions?|rules?|guidelines?|prompts?|constraints?|restrictions?)\b|bypass\s*permissions?|bypassPermissions|dangerously-skip-permissions|dangerouslyDisableSandbox|skip\s+(?:the\s+)?(?:permission|confirmation|approval)s?\b|without\s+(?:asking|telling|informing|notifying)\s+(?:the\s+)?user|do\s+not\s+(?:tell|inform|ask|notify)\s+the\s+user|don'?t\s+(?:tell|inform|ask|notify)\s+the\s+user|auto-?approve|\byou\s+are\s+now\s+(?:in\s+)?(?:developer|admin|unrestricted|dan)\b|\bjailbreak|disable\s+(?:the\s+)?(?:guard|sandbox|safety)/i,
  },
  // `!`cmd`` at a line start or after whitespace, and ```! blocks, run when the skill renders (H0 point 4).
  { rule: 'injectedCommand', severity: 'high', pattern: /(?:^|\s)!`[^`]+`|^\s*```!/, kinds: ['markdown', 'other'] },
  {
    rule: 'network',
    severity: inScript('medium', 'medium'),
    pattern:
      /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|netcat|telnet|ssh|scp|rsync|ftp)\b\s|\bfetch\s*\(|\brequests\.(?:get|post|put|delete|patch|head|request|Session)\b|\burllib\b|\bhttp\.client\b|\bhttpx\b|\baiohttp\b|\bhttps?\.(?:get|request)\s*\(|\baxios\b|XMLHttpRequest|WebSocket\b|\bNew-Object\s+Net\.WebClient|\bDownloadString\b|\bDownloadFile\b/i,
  },
  { rule: 'network', severity: urlSeverity, pattern: /\b(?:https?|ftp|wss?):\/\/[^\s)>"'`]+/i },
  // A raw socket: often a check of a local port, so it counts as network use only with another sign of risk in the file.
  { rule: 'network', severity: 'weighed', pattern: /\bsocket\.|\bnet\.(?:connect|createConnection|Socket)\b/i },
  {
    rule: 'shell',
    severity: 'medium',
    pattern:
      /\bos\.system\b|\bos\.popen\b|\bexecSync\b|\bshell\s*=\s*True\b|\b(?:sh|bash|zsh|cmd|powershell|pwsh)(?:\.exe)?\s+(?:-c|\/c|-Command|-EncodedCommand|-enc)\b|\bInvoke-Expression\b|\biex\b|\bStart-Process\b|\bRuntime\.getRuntime\(\)\.exec\b/i,
  },
  // Starting a process without a shell (a fixed argument list) is common in helpers; weighed by the rest of the file.
  { rule: 'shell', severity: 'weighed', pattern: /\bsubprocess\b|\bPopen\b|\bchild_process\b|\bspawnSync\b|\bexecFile\b/i },
  {
    rule: 'deletion',
    severity: 'medium',
    pattern:
      /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|r)\b|\brmdir\s+\/s\b|\bdel\s+\/[fsq]\b|\bRemove-Item\b[^\n]*-Recurse|\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir)\b|\bfs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b|\brimraf\b|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=/i,
  },
  {
    rule: 'writeOutside',
    severity: 'medium',
    pattern:
      /\bsudo\b|\bchmod\s+[0-7+]|\bchown\b|>\s*(?:\/etc\/|\/usr\/|~\/|\$HOME|%USERPROFILE%|%APPDATA%|[A-Za-z]:\\)|\.(?:bashrc|zshrc|profile|bash_profile)\b|\bcrontab\b|\bschtasks\b|\blaunchctl\b|\bsystemctl\b|\bHKLM:|\bHKCU:|\breg\s+add\b|\bSet-ItemProperty\b[^\n]*HK|\/etc\/(?:passwd|shadow|hosts|sudoers)|\bStartup\b[^\n]*\\Programs/i,
  },
  {
    rule: 'credentials',
    severity: 'high',
    pattern:
      /~\/\.ssh|\.ssh[\\/]|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.aws[\\/]credentials|\.aws\/config|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b|\.docker[\\/]config\.json|\.kube[\\/]config|\.credentials\.json\b|\bkeychain\b|security\s+find-(?:generic|internet)-password|Login Data|Local State|\bCookies\b[^\n]*(?:Chrome|Edge|Firefox|Brave)|(?:Chrome|Chromium|Edge|Brave)[\\/ ]+User Data|\.mozilla[\\/]firefox|Firefox[\\/]Profiles|\bwallet\.dat\b|\.gnupg\b/i,
  },
  {
    rule: 'credentials',
    severity: 'medium',
    pattern:
      /(?:^|[^\w.])\.env\b|\bprocess\.env\b|\bos\.environ\b|\bos\.getenv\b|\$env:|\bprintenv\b|\bGetEnvironmentVariable\b|\b(?:ANTHROPIC|OPENAI|AWS|GITHUB|GH|NPM|SLACK)_[A-Z_]*(?:KEY|TOKEN|SECRET)\b|\b(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD)\b/i,
  },
  {
    rule: 'obfuscation',
    severity: 'high',
    pattern:
      /[A-Za-z0-9+/]{200,}={0,2}|\b[0-9a-fA-F]{200,}\b|(?:\\x[0-9a-fA-F]{2}){20,}|\bbase64\s+(?:-d|--decode)\b|\batob\s*\(|\bb64decode\b|\bFromBase64String\b|\bexec\s*\(\s*compile\b|\beval\s*\(|\bexec\s*\(\s*(?:base64|codecs|zlib|marshal)|\bcodecs\.decode\b|\bmarshal\.loads\b|\bString\.fromCharCode\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+/,
  },
  // An absolute Linux path: on Windows it lands under the current drive (`C:\tmp`), which seldom exists or is meant.
  { rule: 'portability', severity: 'low', pattern: /(?:^|[\s'"`=(,[{])\/(?:tmp|mnt|home)(?=[/\s'"`),;:\]}]|$)/, kinds: ['script'] },
  {
    rule: 'settings',
    severity: 'high',
    pattern: /\.claude[\\/](?:settings(?:\.local)?\.json|agents|skills|hooks|commands)\b|\bsettings(?:\.local)?\.json\b|\.mcp\.json\b|\bCLAUDE\.md\b[^\n]*(?:write|edit|append|overwrite|modify)/i,
  },
];

function excerptOf(line: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = redactSecretLines(line).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  return clean.length > MAX_EXCERPT ? `${clean.slice(0, MAX_EXCERPT)}…` : clean;
}

const moreSevere = (a: Severity | undefined, b: Severity | undefined): Severity | undefined =>
  a === undefined ? b : b === undefined ? a : SEVERITY_ORDER[a] <= SEVERITY_ORDER[b] ? a : b;

/**
 * One finding per rule per line, with the highest severity of the patterns
 * that matched. Weighed patterns are decided last, from the rest of the file:
 * `medium` when any other finding of the file (or `risky`, a sign found
 * outside the lines) is `medium` or `high`, `low` otherwise.
 */
function lineFindings(path: string, content: string, kind: FileKind, risky = false): ReviewFinding[] {
  const found: { finding: ReviewFinding; fixed: Severity | undefined; weighed: boolean }[] = [];
  const lines = (content.startsWith(BOM) ? content.slice(1) : content).split(/\r?\n/);
  lines.forEach((line, index) => {
    const byRule = new Map<FindingRule, { fixed: Severity | undefined; weighed: boolean }>();
    for (const rule of LINE_RULES) {
      if (rule.kinds !== undefined && !rule.kinds.includes(kind)) continue;
      if (!rule.pattern.test(line)) continue;
      const entry = byRule.get(rule.rule) ?? { fixed: undefined, weighed: false };
      if (rule.severity === 'weighed') entry.weighed = true;
      else entry.fixed = moreSevere(entry.fixed, typeof rule.severity === 'function' ? rule.severity({ kind, path, line }) : rule.severity);
      byRule.set(rule.rule, entry);
    }
    for (const [rule, entry] of byRule) {
      found.push({ finding: { rule, severity: entry.fixed ?? 'low', file: path, line: index + 1, excerpt: excerptOf(line) }, ...entry });
    }
    if (findSecrets(line).length > 0) found.push({ finding: { rule: 'secret', severity: 'high', file: path, line: index + 1, excerpt: excerptOf(line) }, fixed: 'high', weighed: false });
    // Minified code: one very long line in a code file.
    if (kind === 'script' && line.length > 1000 && !byRule.has('obfuscation')) {
      found.push({ finding: { rule: 'obfuscation', severity: 'medium', file: path, line: index + 1, excerpt: excerptOf(line) }, fixed: 'medium', weighed: false });
    }
  });
  const signOfRisk = risky || found.some((item) => item.fixed !== undefined && SEVERITY_ORDER[item.fixed] <= SEVERITY_ORDER.medium);
  return found.map(({ finding, fixed, weighed }) => (weighed ? { ...finding, severity: moreSevere(fixed, signOfRisk ? 'medium' : 'low') as Severity } : finding));
}

/** Files that make the skill folder more than instructions: a plugin, hooks, settings, MCP servers. */
function fileFindings(item: InventoryItem): ReviewFinding[] {
  const lower = item.path.toLowerCase();
  const name = baseName(lower);
  const out: ReviewFinding[] = [];
  if (lower === '.claude-plugin/plugin.json' || lower.startsWith('.claude-plugin/')) out.push({ rule: 'plugin', severity: 'high', file: item.path });
  else if (name === 'hooks.json' || lower.startsWith('hooks/') || lower.includes('/hooks/')) out.push({ rule: 'hooks', severity: 'high', file: item.path });
  else if (name === 'settings.json' || name === 'settings.local.json' || name === '.mcp.json' || lower.startsWith('.claude/')) {
    out.push({ rule: 'settings', severity: 'high', file: item.path });
  }
  if (item.kind === 'script') out.push({ rule: 'script', severity: 'medium', file: item.path });
  if (item.kind === 'binary') {
    const ext = extensionOf(item.path);
    const runs = EXECUTABLE_BINARY_EXT.has(ext) || ARCHIVE_EXT.has(ext) || item.executable;
    out.push({ rule: 'binary', severity: runs ? 'high' : 'low', file: item.path });
  }
  return out;
}

const APP_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function frontmatterFindings(frontmatter: SkillFrontmatter): ReviewFinding[] {
  const file = 'SKILL.md';
  const out: ReviewFinding[] = [];
  if (!frontmatter.parsed) out.push({ rule: 'frontmatter', severity: 'low', file, excerpt: 'no frontmatter, or it does not parse' });
  else if (frontmatter.description === undefined || frontmatter.description === '') {
    out.push({ rule: 'frontmatter', severity: 'low', file, excerpt: 'no description' });
  }
  if (frontmatter.hooks) out.push({ rule: 'hooks', severity: 'high', file, excerpt: 'hooks in the frontmatter' });
  if (frontmatter.allowedTools !== undefined && frontmatter.allowedTools !== '') {
    const unrestricted = /(?:^|[\s,])(?:Bash|PowerShell|Write|Edit|WebFetch)(?:$|[\s,])/.test(frontmatter.allowedTools) || frontmatter.allowedTools.includes('*');
    out.push({ rule: 'allowedTools', severity: unrestricted ? 'high' : 'medium', file, excerpt: excerptOf(`allowed-tools: ${frontmatter.allowedTools}`) });
  }
  if (frontmatter.shell !== undefined) out.push({ rule: 'shell', severity: 'low', file, excerpt: excerptOf(`shell: ${frontmatter.shell}`) });
  const name = frontmatter.name;
  if (name !== undefined && (name.length > 64 || !APP_NAME_RE.test(name) || /anthropic|claude/i.test(name))) {
    out.push({ rule: 'appName', severity: 'low', file, excerpt: excerptOf(`name: ${name}`) });
  }
  if ((frontmatter.description?.length ?? 0) > 200) out.push({ rule: 'appDescription', severity: 'info', file });
  if (frontmatter.disableModelInvocation) out.push({ rule: 'frontmatter', severity: 'info', file, excerpt: 'disable-model-invocation: true' });
  return out;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Runs every static check. Nothing from the skill is executed. */
export function reviewSkill(input: ReviewInput): StaticReview {
  const items = inventory(input.files);
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const skillMd = byPath.get('SKILL.md');
  const frontmatter = readSkillFrontmatter(skillMd?.bytes.toString('utf8') ?? '');
  const license = detectLicense(input.files, frontmatter, input.rootLicense);

  let findings: ReviewFinding[] = [...frontmatterFindings(frontmatter)];
  for (const item of items) {
    findings.push(...fileFindings(item));
    const file = byPath.get(item.path);
    if (file === undefined || item.kind === 'binary') continue;
    const decoded = decodeText(file.bytes);
    const misencoded = item.kind === 'script' && decoded.encoding !== 'utf-8';
    if (misencoded) findings.push({ rule: 'encoding', severity: 'high', file: item.path, excerpt: `not UTF-8 text; read as ${decoded.encoding}` });
    findings.push(...lineFindings(item.path, decoded.text, item.kind, misencoded));
  }
  if (license.source === 'none') findings.push({ rule: 'license', severity: 'medium', file: '', excerpt: 'no license found' });
  else if (license.spdx === null) findings.push({ rule: 'license', severity: 'low', file: license.file ?? '', excerpt: 'license not recognised' });

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0));
  if (findings.length > MAX_FINDINGS) {
    const total = findings.length;
    findings = findings.slice(0, MAX_FINDINGS - 1);
    findings.push({ rule: 'truncated', severity: 'info', file: '', excerpt: `${total - findings.length} more findings not listed` });
  }
  return {
    inventory: items,
    frontmatter,
    license,
    findings,
    hasScripts: items.some((item) => item.kind === 'script' || (item.kind === 'binary' && fileFindings(item).some((f) => f.severity === 'high'))),
    // A link in prose, an address on this machine or a lone socket is not network use; a network call, or an outside address in a script, is.
    network: findings.some((f) => f.rule === 'network' && (f.severity === 'medium' || f.severity === 'high')),
  };
}

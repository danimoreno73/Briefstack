import { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL } from './toolNames.js';

/**
 * The SDK warns with this code when `allowedTools` holds bare tool names,
 * because `canUseTool` is never called for them.
 */
export const SHADOWED_WARNING_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';

/**
 * The only bare names a creation puts in `allowedTools`. Shadowing them is
 * safe on purpose: they are our own `briefstack-web` tools, and their
 * handlers wait for the user's answer in the browser themselves (approve the
 * spec, grant a folder). A `canUseTool` prompt would only ask twice. Every
 * other tool still goes through the guard (`PreToolUse`) and `canUseTool`.
 */
export const SHADOWED_WEB_TOOLS: readonly string[] = [APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL];

const LISTED_RE = /canUseTool will not be invoked for: (.+?)\. /;

function codeOf(args: readonly unknown[]): string | undefined {
  const [, second, third] = args;
  if (typeof second === 'object' && second !== null) {
    const code = (second as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return typeof third === 'string' ? third : undefined;
}

/**
 * True only for the shadowing warning when the tools it names are exactly
 * the two `briefstack-web` tools. A warning naming any other tool, a
 * different code, or a message in a shape we do not recognise is not ours to
 * hide.
 */
export function isKnownShadowedWarning(args: readonly unknown[]): boolean {
  if (codeOf(args) !== SHADOWED_WARNING_CODE) return false;
  const [warning] = args;
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : undefined;
  const listed = message === undefined ? undefined : LISTED_RE.exec(message)?.[1];
  if (listed === undefined) return false;
  const names = listed.split(',').map((name) => name.trim());
  return (
    names.length === SHADOWED_WEB_TOOLS.length &&
    SHADOWED_WEB_TOOLS.every((name) => names.includes(name))
  );
}

interface WarningTarget {
  emitWarning: (...args: never[]) => void;
}

const installed = new WeakSet<object>();

/**
 * Drops the known shadowing warning (see `SHADOWED_WEB_TOOLS`) and passes
 * every other warning through unchanged. Installed once per process; calling
 * it again does nothing.
 */
export function filterKnownSdkWarnings(target: WarningTarget = process): void {
  if (installed.has(target)) return;
  installed.add(target);
  const original = target.emitWarning.bind(target) as (...args: unknown[]) => void;
  target.emitWarning = ((...args: unknown[]) => {
    if (isKnownShadowedWarning(args)) return;
    original(...args);
  }) as WarningTarget['emitWarning'];
}

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { isFullyAbsolute, isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { inspectOutputDir, type ProtectedDir } from '../scaffold/outputDir.js';
import { claimRefusedMessage } from './folderClaims.js';
import { insideAny } from './guard.js';
import { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL, WEB_SERVER_NAME } from './toolNames.js';
import type { RunnerIO } from './types.js';

/**
 * The two in-process MCP tools web sessions get (PLAN-phase-2 §1, doubt 2).
 * The skill uses them in place of two plain-text exchanges the browser cannot
 * have: the spec approval, and the folder permission (`/add-dir`). They are an
 * I/O channel, not a copy of the flow: the steps around them are the same
 * with or without them.
 */

export { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL, WEB_SERVER_NAME };

export interface WebToolsDeps {
  io: Pick<RunnerIO, 'approveSpec' | 'grantDirectory' | 'claimFolder' | 'refreshFolderClaims'>;
  /** The session folder, once the session id is known. Spec files must be inside it. */
  sessionDir(): string | undefined;
  /** Folders a granted output folder must not overlap (`protectedDirs`). */
  protectedDirs: readonly ProtectedDir[];
  /** The projects folder: granting it needs no confirmation, so it is refused as redundant. */
  projectsDir: string;
  /** Records a folder the user confirmed, for this session only. */
  onGrant(dir: string): void;
  pathEnv?: PathEnv;
}

export interface ToolReply {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const reply = (value: unknown, isError = false): ToolReply => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

const fail = (message: string): ToolReply => reply({ error: message }, true);

/** `approve_spec`: the answer is `approve`, `change` with the user's text, or `cancel`. */
export async function approveSpec(deps: WebToolsDeps, args: { specFile: string; summaryFile: string }): Promise<ToolReply> {
  const pathEnv = deps.pathEnv ?? systemPathEnv();
  const sessionDir = deps.sessionDir();
  if (sessionDir === undefined) return fail('The session is not open yet.');
  for (const file of [args.specFile, args.summaryFile]) {
    // After symlinks, as the guard compares: a link in the session folder that leads out does not count as inside.
    if (!isFullyAbsolute(file, pathEnv.pathApi) || !(await insideAny(file, [sessionDir], pathEnv))) {
      return fail('Both files must be absolute paths inside the session folder.');
    }
  }
  const result = await deps.io.approveSpec({ specFile: args.specFile, summaryFile: args.summaryFile });
  return reply(result);
}

/**
 * `grant_directory`: asks the user to confirm writes in an output folder
 * outside the projects folder, for this session only. Nothing is written to
 * any settings file. A missing folder is created only after the user said yes.
 */
export async function grantDirectory(deps: WebToolsDeps, args: { dir: string }): Promise<ToolReply> {
  const pathEnv = deps.pathEnv ?? systemPathEnv();
  const { pathApi } = pathEnv;
  if (!isFullyAbsolute(args.dir, pathApi)) return fail('Use a full path with a drive letter or a leading slash.');
  const dir = pathApi.resolve(args.dir);
  if (isPathInside(dir, deps.projectsDir, pathEnv)) return reply({ granted: true, note: 'Already inside the projects folder.' });

  const report = await inspectOutputDir(dir, [...deps.protectedDirs]);
  if (report.status === 'forbidden') {
    return fail(
      `That folder overlaps a protected folder (${report.overlaps?.root ?? 'protected'}): the briefstack repository, the ` +
        "personal library, briefstack's own folder, Claude Code's settings or AppData, or a folder that contains one of them.",
    );
  }
  if (report.status === 'notADirectory') return fail('That path is a file, not a folder.');
  // Before the user is asked: a folder another creation in progress holds is refused outright.
  await deps.io.refreshFolderClaims?.();
  const claim = deps.io.claimFolder(dir);
  if (!claim.ok) return fail(claimRefusedMessage(dir, claim.holder, deps.projectsDir, pathEnv));

  const granted = await deps.io.grantDirectory({ dir });
  if (!granted) return reply({ granted: false });
  await mkdir(dir, { recursive: true });
  deps.onGrant(dir);
  return reply({ granted: true });
}

/** The server for the SDK's `mcpServers` option. */
export function createWebToolsServer(deps: WebToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: WEB_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'approve_spec',
        'Show the user the spec summary and ask them to approve it, change it or cancel. Returns {"decision":"approve"}, {"decision":"change","text":"..."} or {"decision":"cancel"}. Both files must be in the session folder.',
        { specFile: z.string().min(1), summaryFile: z.string().min(1) },
        async (args) => approveSpec(deps, args),
        { alwaysLoad: true },
      ),
      tool(
        'grant_directory',
        'Ask the user to confirm that this session may write in an output folder outside the projects folder. Returns {"granted":true} or {"granted":false}. Takes effect for this session only.',
        { dir: z.string().min(1) },
        async (args) => grantDirectory(deps, args),
        { alwaysLoad: true },
      ),
    ],
  });
}

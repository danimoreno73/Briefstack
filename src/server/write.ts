import { z } from 'zod';
import { CODEX_SANDBOX_MODES, MAX_CODEX_MAX_CALLS, MIN_CODEX_MAX_CALLS, type CodexSandboxMode } from '../codex/limits.js';
import { MAX_IMPLEMENT_MINUTES, MAX_IMPLEMENT_TOOL_CALLS, MIN_IMPLEMENT_MINUTES, MIN_IMPLEMENT_TOOL_CALLS } from '../config/limits.js';
import {
  codexSettingsOf,
  configFilePath,
  implementBoundsOf,
  PERMISSION_POLICIES,
  maxActiveCreationsOf,
  permissionPolicyOf,
  type PermissionPolicy,
  readConfig,
  resolvePaths,
  updateConfig,
  usageWarningOf,
  type PathEnv,
} from '../config/index.js';
import { setSessionArchived } from '../events/archived.js';
import { LANGS, resolveLang, systemLocale, type Lang } from '../i18n/index.js';
import { revertLibraryCommit, saveNote, setProjectArchived, setProjectsDir } from '../library/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { EFFORT_LEVELS } from '../models.js';
import { baseProfilesFile, createUserPreset, FLOW_AGENTS, PROFILE_NAME_RE, usageSet } from '../usage/index.js';
import { readJsonBody, sendJson } from './http.js';
import type { RouteTable } from './router.js';

/** What the write routes need; the same shape as the read routes. */
export interface WriteContext {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
}

const MAX_NOTE_BYTES = 48 * 1024;

const noteBody = z.strictObject({
  section: z.string().min(1).max(40),
  name: z.string().min(1).max(120).optional(),
  // A note larger than the body limit is refused by the body reader (413).
  text: z.string().max(MAX_NOTE_BYTES),
});
const revertBody = z.strictObject({ sha: z.string().regex(/^[0-9a-fA-F]{4,64}$/) });
const archiveBody = z.strictObject({ archived: z.boolean() });
const usageBody = z.strictObject({ profile: z.string().min(1).max(80) });
const agentChange = z.strictObject({ model: z.string().min(1).max(80), effort: z.enum(EFFORT_LEVELS).optional() });
/** A user preset from another one (IDEAS §3; step 33); the schema check of the CLI runs on the result. */
const presetBody = z.strictObject({
  name: z.string().regex(PROFILE_NAME_RE).max(60),
  base: z.string().min(1).max(80),
  label: z.strictObject({ en: z.string().trim().min(1).max(80), es: z.string().trim().min(1).max(80) }),
  sessionModel: z.string().min(1).max(80).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  agents: z.partialRecord(z.enum(FLOW_AGENTS), agentChange).optional(),
});
const settingsBody = z
  .strictObject({
    projectsDir: z.string().min(1).max(1024).optional(),
    /** `null` removes the saved language, so the OS locale decides again. */
    lang: z.enum(LANGS).nullable().optional(),
    permissionPolicy: z.enum(PERMISSION_POLICIES).optional(),
    maxActiveCreations: z.int().min(1).optional(),
    usageWarnFiveHour: z.int().min(1).max(100).optional(),
    usageWarnWeek: z.int().min(1).max(100).optional(),
    codexEnabled: z.boolean().optional(),
    codexMode: z.enum(CODEX_SANDBOX_MODES).optional(),
    codexMaxCalls: z.int().min(MIN_CODEX_MAX_CALLS).max(MAX_CODEX_MAX_CALLS).optional(),
    implementMaxMinutes: z.int().min(MIN_IMPLEMENT_MINUTES).max(MAX_IMPLEMENT_MINUTES).optional(),
    implementMaxToolCalls: z.int().min(MIN_IMPLEMENT_TOOL_CALLS).max(MAX_IMPLEMENT_TOOL_CALLS).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one setting' });

/**
 * Mutating routes: save a note, revert a library commit, set the usage
 * profile and change settings (docs/api.md). Each parses its body with zod and
 * calls the same library code as the CLI. Responses never echo note text, so
 * a refused note's content does not come back.
 */
export function writeRoutes(context: WriteContext): RouteTable {
  const { pathEnv } = context;
  const repoDir = context.repoDir ?? PACKAGE_ROOT;

  const load = async () => {
    const config = await readConfig(configFilePath(pathEnv));
    return { config, paths: resolvePaths(config, pathEnv) };
  };

  const settingsView = async () => {
    const { config, paths } = await load();
    const lang: Lang = resolveLang({ env: pathEnv.env, configLang: config.lang, osLocale: systemLocale() });
    return {
      projectsDir: paths.projectsDir,
      lang,
      configLang: config.lang ?? null,
      permissionPolicy: permissionPolicyOf(config),
      maxActiveCreations: maxActiveCreationsOf(config),
      usageWarning: usageWarningOf(config),
      codex: codexSettingsOf(config),
      implement: implementBoundsOf(config),
    };
  };

  return [
    [
      'PUT /api/library/note',
      async (req, res) => {
        const body = await readJsonBody(req, noteBody);
        const { paths } = await load();
        const saved = await saveNote({
          libraryDir: paths.libraryDir,
          section: body.section,
          ...(body.name === undefined ? {} : { name: body.name }),
          text: body.text,
        });
        sendJson(res, 200, saved);
      },
    ],
    [
      'PUT /api/projects/:slug/archived',
      async (req, res, params) => {
        const { archived } = await readJsonBody(req, archiveBody);
        const { paths } = await load();
        sendJson(res, 200, await setProjectArchived({ libraryDir: paths.libraryDir, slug: params.slug ?? '', archived }));
      },
    ],
    [
      // Archive or restore an interrupted or cancelled creation: a choice in the home, nothing deleted (IDEAS §3; step 33).
      'PUT /api/sessions/:id/archived',
      async (req, res, params) => {
        const { archived } = await readJsonBody(req, archiveBody);
        const { paths } = await load();
        sendJson(res, 200, await setSessionArchived({ home: paths.home, sessionsDir: paths.sessionsDir, id: params.id ?? '', archived }));
      },
    ],
    [
      'POST /api/library/revert',
      async (req, res) => {
        const { sha } = await readJsonBody(req, revertBody);
        const { paths } = await load();
        sendJson(res, 200, { reverted: sha, commit: await revertLibraryCommit(paths.libraryDir, sha) });
      },
    ],
    [
      'PUT /api/usage',
      async (req, res) => {
        const { profile } = await readJsonBody(req, usageBody);
        const result = await usageSet({ pathEnv, repoDir, profile });
        sendJson(res, 200, { scope: result.scope, profile: result.profile, sessionModel: result.sessionModel });
      },
    ],
    [
      // A new user preset from another one: written to the user's usage-profiles.json only. No agent file is touched:
      // `.claude/agents/*.md` change only through `briefstack usage set` (PUT /api/usage), when the user chooses it.
      'POST /api/usage/presets',
      async (req, res) => {
        const body = await readJsonBody(req, presetBody);
        const { paths } = await load();
        const created = await createUserPreset({ baseFile: baseProfilesFile(), userFile: paths.userProfilesFile }, body);
        sendJson(res, 201, { name: created.name });
      },
    ],
    [
      'PUT /api/settings',
      async (req, res) => {
        const body = await readJsonBody(req, settingsBody);
        const patch: {
          lang?: Lang | undefined;
          permissionPolicy?: PermissionPolicy;
          maxActiveCreations?: number;
          usageWarnFiveHour?: number;
          usageWarnWeek?: number;
          codexEnabled?: boolean;
          codexMode?: CodexSandboxMode;
          codexMaxCalls?: number;
          implementMaxMinutes?: number;
          implementMaxToolCalls?: number;
        } = {};
        if (body.implementMaxMinutes !== undefined) patch.implementMaxMinutes = body.implementMaxMinutes;
        if (body.implementMaxToolCalls !== undefined) patch.implementMaxToolCalls = body.implementMaxToolCalls;
        if (body.codexEnabled !== undefined) patch.codexEnabled = body.codexEnabled;
        if (body.codexMode !== undefined) patch.codexMode = body.codexMode;
        if (body.codexMaxCalls !== undefined) patch.codexMaxCalls = body.codexMaxCalls;
        if (body.lang !== undefined) patch.lang = body.lang ?? undefined;
        if (body.permissionPolicy !== undefined) patch.permissionPolicy = body.permissionPolicy;
        if (body.maxActiveCreations !== undefined) patch.maxActiveCreations = body.maxActiveCreations;
        if (body.usageWarnFiveHour !== undefined) patch.usageWarnFiveHour = body.usageWarnFiveHour;
        if (body.usageWarnWeek !== undefined) patch.usageWarnWeek = body.usageWarnWeek;
        // The projects folder goes first: it validates the path before anything is written.
        if (body.projectsDir !== undefined) await setProjectsDir({ pathEnv, repoDir, dir: body.projectsDir });
        if (Object.keys(patch).length > 0) await updateConfig(configFilePath(pathEnv), patch);
        sendJson(res, 200, await settingsView());
      },
    ],
  ];
}

import { z } from 'zod';
import {
  configFilePath,
  PERMISSION_POLICIES,
  maxActiveCreationsOf,
  permissionPolicyOf,
  type PermissionPolicy,
  readConfig,
  resolvePaths,
  updateConfig,
  type PathEnv,
} from '../config/index.js';
import { LANGS, resolveLang, systemLocale, type Lang } from '../i18n/index.js';
import { revertLibraryCommit, saveNote, setProjectsDir } from '../library/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { usageSet } from '../usage/index.js';
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
const usageBody = z.strictObject({ profile: z.string().min(1).max(80) });
const settingsBody = z
  .strictObject({
    projectsDir: z.string().min(1).max(1024).optional(),
    /** `null` removes the saved language, so the OS locale decides again. */
    lang: z.enum(LANGS).nullable().optional(),
    permissionPolicy: z.enum(PERMISSION_POLICIES).optional(),
    maxActiveCreations: z.int().min(1).optional(),
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
      'PUT /api/settings',
      async (req, res) => {
        const body = await readJsonBody(req, settingsBody);
        const patch: { lang?: Lang | undefined; permissionPolicy?: PermissionPolicy; maxActiveCreations?: number } = {};
        if (body.lang !== undefined) patch.lang = body.lang ?? undefined;
        if (body.permissionPolicy !== undefined) patch.permissionPolicy = body.permissionPolicy;
        if (body.maxActiveCreations !== undefined) patch.maxActiveCreations = body.maxActiveCreations;
        // The projects folder goes first: it validates the path before anything is written.
        if (body.projectsDir !== undefined) await setProjectsDir({ pathEnv, repoDir, dir: body.projectsDir });
        if (Object.keys(patch).length > 0) await updateConfig(configFilePath(pathEnv), patch);
        sendJson(res, 200, await settingsView());
      },
    ],
  ];
}

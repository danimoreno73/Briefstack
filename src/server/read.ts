import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath, permissionPolicyOf, readConfig, resolvePaths, toAbsolute, type PathEnv } from '../config/index.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { listSessions, sessionTimeline, type SessionTimeline } from '../events/sessions.js';
import { resolveLang, systemLocale, type Lang } from '../i18n/index.js';
import {
  INDEX_FILE,
  libraryExists,
  libraryHistory,
  listNotes,
  listProjects,
  readAdditionalDirectories,
  readNote,
  toNative,
} from '../library/index.js';
import { readTextIfExists } from '../library/notes.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { inspectOutputDir, protectedDirs } from '../scaffold/outputDir.js';
import { loadUsageContext, usageShow } from '../usage/index.js';
import { redactSecretLines } from '../validate/index.js';
import { sendJson } from './http.js';
import type { RouteTable } from './router.js';

/** What the read routes need to find the user's files. */
export interface ReadContext {
  pathEnv: PathEnv;
  /** The briefstack repo, whose agent files and settings `usage` and `paths` report. */
  repoDir?: string | undefined;
  /** Language of labels in responses; by default the one the CLI would use. */
  lang?: Lang | undefined;
}

/** Largest generated file the project detail returns. */
const MAX_PROJECT_FILE_BYTES = 256 * 1024;
const MAX_HISTORY_LIMIT = 200;

/** Secrets never reach the UI: a line that looks like one is replaced. */
export const redactSecrets = redactSecretLines;

async function readProjectFile(projectDir: string, name: string): Promise<string | null> {
  const file = path.join(projectDir, name);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_PROJECT_FILE_BYTES) return null;
    return redactSecrets(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function query(req: { url?: string | undefined }): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams;
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value === '') throw new BriefstackError('web.invalidQuery', { name, value: '' });
  return value;
}

/**
 * Read-only routes: projects, sessions, the library, usage, paths and
 * settings (docs/api.md). Every call reads the config again, so a change
 * made from the CLI shows at once.
 */
export function readRoutes(context: ReadContext): RouteTable {
  const { pathEnv } = context;
  const repoDir = context.repoDir ?? PACKAGE_ROOT;

  const load = async () => {
    const config = await readConfig(configFilePath(pathEnv));
    const paths = resolvePaths(config, pathEnv);
    const lang = context.lang ?? resolveLang({ env: pathEnv.env, configLang: config.lang, osLocale: systemLocale() });
    return { config, paths, lang };
  };

  const timelineOf = async (sessionsDir: string, id: string | undefined): Promise<SessionTimeline | null> => {
    if (id === undefined) return null;
    try {
      return await sessionTimeline(sessionsDir, id);
    } catch (error) {
      if (isBriefstackError(error) && error.code === 'events.sessionNotFound') return null;
      throw error;
    }
  };

  return [
    [
      'GET /api/projects',
      async (_req, res) => {
        const { paths } = await load();
        sendJson(res, 200, { projects: await listProjects(paths.libraryDir) });
      },
    ],
    [
      'GET /api/projects/:slug',
      async (_req, res, params) => {
        const { paths } = await load();
        const slug = params.slug ?? '';
        // `readNote` validates the slug and fails with `library.noteNotFound` (404).
        const note = await readNote(paths.libraryDir, 'projects', slug);
        const listing = (await listProjects(paths.libraryDir)).find((item) => item.slug === slug);
        const status = listing?.status;
        const projectDir = status?.path;
        const isApp = status?.target === 'claude-app' && projectDir !== undefined;
        sendJson(res, 200, {
          project: listing ?? null,
          note: { file: note.file, text: redactSecrets(note.text) },
          timeline: await timelineOf(paths.sessionsDir, listing?.session),
          nextSteps: isApp ? await readProjectFile(projectDir, 'NEXT_STEPS.md') : null,
          instructions: isApp ? await readProjectFile(projectDir, 'INSTRUCTIONS.md') : null,
          openCommand: projectDir === undefined ? null : { cwd: projectDir, command: 'claude' },
        });
      },
    ],
    [
      'GET /api/sessions',
      async (_req, res) => {
        const { paths } = await load();
        sendJson(res, 200, { sessions: await listSessions(paths.sessionsDir) });
      },
    ],
    [
      'GET /api/sessions/:id',
      async (_req, res, params) => {
        const { paths } = await load();
        sendJson(res, 200, await sessionTimeline(paths.sessionsDir, params.id ?? ''));
      },
    ],
    [
      'GET /api/library/index',
      async (_req, res) => {
        const { paths } = await load();
        const text = await readTextIfExists(toNative(paths.libraryDir, INDEX_FILE));
        sendJson(res, 200, { file: INDEX_FILE, text: text === undefined ? null : redactSecrets(text) });
      },
    ],
    [
      'GET /api/library/notes',
      async (req, res) => {
        const { paths } = await load();
        const section = query(req).get('section') ?? undefined;
        sendJson(res, 200, { notes: await listNotes(paths.libraryDir, section) });
      },
    ],
    [
      'GET /api/library/note',
      async (req, res) => {
        const { paths } = await load();
        const params = query(req);
        const section = required(params, 'section');
        const note = await readNote(paths.libraryDir, section, params.get('name') ?? undefined);
        sendJson(res, 200, { file: note.file, text: redactSecrets(note.text) });
      },
    ],
    [
      'GET /api/library/history',
      async (req, res) => {
        const { paths } = await load();
        const value = query(req).get('limit');
        let limit: number | undefined;
        if (value !== null) {
          limit = Number(value);
          if (!/^\d{1,4}$/.test(value) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
            throw new BriefstackError('web.invalidQuery', { name: 'limit', value });
          }
        }
        sendJson(res, 200, { commits: await libraryHistory(paths.libraryDir, limit === undefined ? {} : { limit }) });
      },
    ],
    [
      'GET /api/usage',
      async (_req, res) => {
        const { lang } = await load();
        const shown = await usageShow({ pathEnv, repoDir, lang });
        const { profiles } = await loadUsageContext(pathEnv);
        const presets = Object.entries(profiles.presets).map(([name, preset]) => ({
          name,
          source: profiles.sources[name],
          label: preset.label,
          sessionModel: preset.sessionModel,
          effort: preset.effort,
          tiers: preset.tiers,
          research: preset.research,
          reviewRounds: preset.reviewRounds,
        }));
        sendJson(res, 200, { ...shown, presets });
      },
    ],
    [
      'GET /api/paths',
      async (_req, res) => {
        const { paths } = await load();
        const { home, configFile, libraryDir, projectsDir, sessionsDir } = paths;
        sendJson(res, 200, {
          home,
          configFile,
          libraryDir,
          libraryExists: await libraryExists(libraryDir),
          projectsDir,
          sessionsDir,
          repoDir,
          allowedDirs: await readAdditionalDirectories(repoDir),
        });
      },
    ],
    [
      // What `paths check` says about a folder (the same inspection), so Settings can warn before saving.
      'GET /api/paths/check',
      async (req, res) => {
        const { paths } = await load();
        const dir = required(query(req), 'dir');
        const absolute = toAbsolute(dir, pathEnv);
        if (absolute === undefined) throw new BriefstackError('config.relativePath', { source: 'dir', value: dir });
        const report = await inspectOutputDir(absolute, protectedDirs(paths.libraryDir, repoDir, pathEnv));
        sendJson(res, 200, {
          outDir: report.outDir,
          status: report.status,
          ...(report.overlaps === undefined ? {} : { overlaps: report.overlaps.root }),
        });
      },
    ],
    [
      'GET /api/settings',
      async (_req, res) => {
        const { config, paths, lang } = await load();
        sendJson(res, 200, {
          projectsDir: paths.projectsDir,
          lang,
          configLang: config.lang ?? null,
          permissionPolicy: permissionPolicyOf(config),
        });
      },
    ],
  ];
}

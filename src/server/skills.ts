import { z } from 'zod';
import { BriefstackError } from '../errors.js';
import { MAX_TAGS } from '../skills/record.js';
import type { SkillService } from '../skills/service.js';
import { MAX_URL_LENGTH } from '../skills/url.js';
import { readJsonBody, sendJson } from './http.js';
import type { RouteParams, RouteTable } from './router.js';

/**
 * Skill routes (docs/api.md, BRIEF-phase-6 §3.4). Without a skill service
 * every one answers 503 `skills.unavailable`. Adding fetches into
 * quarantine; approving, rejecting and deleting happen only here, on the
 * Skills page (the chat can only add).
 */

const addBody = z.strictObject({
  url: z.string().trim().min(1).max(MAX_URL_LENGTH),
  tags: z.array(z.string().max(60)).max(MAX_TAGS).optional(),
});
const tagsBody = z.strictObject({ tags: z.array(z.string().max(60)).max(MAX_TAGS * 2) });

function query(req: { url?: string | undefined }): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams;
}

export function skillRoutes(skills: SkillService | undefined): RouteTable {
  const need = (): SkillService => {
    if (skills === undefined) throw new BriefstackError('skills.unavailable', {});
    return skills;
  };
  const name = (params: RouteParams): string => params.name ?? '';

  return [
    ['GET /api/skills', async (_req, res) => sendJson(res, 200, { skills: await need().list() })],
    ['GET /api/skills/:name', async (_req, res, params) => sendJson(res, 200, await need().get(name(params)))],
    [
      'GET /api/skills/:name/file',
      async (req, res, params) => {
        const q = query(req);
        const file = q.get('path') ?? '';
        const version = q.get('version') === 'next' ? 'next' : 'current';
        if (file === '' || file.length > 400) throw new BriefstackError('web.invalidQuery', { name: 'path', value: file.slice(0, 80) });
        sendJson(res, 200, await need().readFile(name(params), file, version));
      },
    ],
    [
      'POST /api/skills',
      async (req, res) => {
        const body = await readJsonBody(req, addBody);
        sendJson(res, 201, await need().add(body.url, body.tags ?? []));
      },
    ],
    ['POST /api/skills/:name/approve', async (_req, res, params) => sendJson(res, 200, await need().approve(name(params)))],
    ['POST /api/skills/:name/reject', async (_req, res, params) => sendJson(res, 200, await need().reject(name(params)))],
    ['POST /api/skills/:name/delete', async (_req, res, params) => sendJson(res, 200, await need().remove(name(params)))],
    [
      'PUT /api/skills/:name/tags',
      async (req, res, params) => {
        const { tags } = await readJsonBody(req, tagsBody);
        sendJson(res, 200, await need().setTags(name(params), tags));
      },
    ],
    ['POST /api/skills/:name/check-update', async (_req, res, params) => sendJson(res, 200, await need().checkUpdate(name(params)))],
    ['POST /api/skills/:name/update/approve', async (_req, res, params) => sendJson(res, 200, await need().approveUpdate(name(params)))],
    ['POST /api/skills/:name/update/reject', async (_req, res, params) => sendJson(res, 200, await need().rejectUpdate(name(params)))],
  ];
}

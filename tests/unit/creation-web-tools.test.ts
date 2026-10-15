import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveSpec, grantDirectory, type WebToolsDeps } from '../../src/creation/webTools.js';
import type { GrantRequest, SpecApprovalRequest, SpecDecision } from '../../src/creation/types.js';
import { tempDir } from '../helpers.js';

describe('web tools', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let deps: WebToolsDeps;
  let granted: string[];
  let specRequests: SpecApprovalRequest[];
  let grantRequests: GrantRequest[];
  let spec: SpecDecision;
  let grantAnswer: boolean;
  let sessionDir: string | undefined;
  const parse = (reply: { content: { text: string }[] }): Record<string, unknown> => JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-tools'));
    sessionDir = path.join(dir, 'sessions', 's1');
    await mkdir(sessionDir, { recursive: true });
    granted = [];
    specRequests = [];
    grantRequests = [];
    spec = { decision: 'approve' };
    grantAnswer = true;
    deps = {
      io: {
        approveSpec: async (request) => {
          specRequests.push(request);
          return spec;
        },
        grantDirectory: async (request) => {
          grantRequests.push(request);
          return grantAnswer;
        },
      },
      sessionDir: () => sessionDir,
      protectedDirs: [
        { root: 'repo', path: path.join(dir, 'repo') },
        { root: 'library', path: path.join(dir, 'library') },
      ],
      projectsDir: path.join(dir, 'projects'),
      onGrant: (granting) => granted.push(granting),
    };
  });
  afterEach(() => cleanup());

  describe('approve_spec', () => {
    it('returns approve, change with the text, or cancel', async () => {
      const files = { specFile: path.join(sessionDir as string, 'spec.json'), summaryFile: path.join(sessionDir as string, 'summary.md') };
      expect(parse(await approveSpec(deps, files))).toEqual({ decision: 'approve' });
      spec = { decision: 'change', text: 'Rename it' };
      expect(parse(await approveSpec(deps, files))).toEqual({ decision: 'change', text: 'Rename it' });
      spec = { decision: 'cancel' };
      expect(parse(await approveSpec(deps, files))).toEqual({ decision: 'cancel' });
      expect(specRequests[0]).toEqual(files);
    });

    it('only takes files inside the session folder', async () => {
      const inside = path.join(sessionDir as string, 'spec.json');
      for (const bad of [path.join(dir, 'elsewhere.json'), path.join(sessionDir as string, '..', 's2', 'spec.json'), 'spec.json']) {
        const reply = await approveSpec(deps, { specFile: bad, summaryFile: inside });
        expect(reply.isError, bad).toBe(true);
      }
      expect(specRequests).toHaveLength(0);
      sessionDir = undefined;
      expect((await approveSpec(deps, { specFile: inside, summaryFile: inside })).isError).toBe(true);
    });
  });

  describe('grant_directory', () => {
    it('creates the folder and records it only after the user confirms', async () => {
      const target = path.join(dir, 'chosen', 'out');
      expect(parse(await grantDirectory(deps, { dir: target }))).toEqual({ granted: true });
      expect(granted).toEqual([path.resolve(target)]);
      expect((await stat(target)).isDirectory()).toBe(true);
      expect(grantRequests).toEqual([{ dir: path.resolve(target) }]);
    });

    it('creates and records nothing when the user says no', async () => {
      grantAnswer = false;
      const target = path.join(dir, 'chosen', 'out');
      expect(parse(await grantDirectory(deps, { dir: target }))).toEqual({ granted: false });
      expect(granted).toEqual([]);
      await expect(stat(target)).rejects.toThrow();
    });

    it('does not ask for a folder inside the projects folder', async () => {
      const reply = parse(await grantDirectory(deps, { dir: path.join(dir, 'projects', 'app') }));
      expect(reply.granted).toBe(true);
      expect(grantRequests).toHaveLength(0);
      expect(granted).toEqual([]);
    });

    it('refuses relative paths, the repo, the library and files, without asking', async () => {
      const file = path.join(dir, 'a-file');
      await writeFile(file, 'x', 'utf8');
      for (const bad of ['relative/out', path.join(dir, 'repo'), path.join(dir, 'repo', 'sub'), path.join(dir, 'library'), dir, file]) {
        expect((await grantDirectory(deps, { dir: bad })).isError, bad).toBe(true);
      }
      expect(grantRequests).toHaveLength(0);
      expect(granted).toEqual([]);
    });
  });
});

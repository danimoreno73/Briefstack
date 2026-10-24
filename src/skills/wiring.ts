import { configFilePath, readConfig, resolvePaths, type PathEnv } from '../config/index.js';
import type { FetchOptions } from './github.js';
import { SdkSkillReviewer, type SkillModelReviewer } from './modelReview.js';
import { SkillService } from './service.js';

/**
 * The skill service `briefstack web` serves: the library from the config at
 * each call, the real GitHub hosts and the real model review unless a test
 * passes its own.
 */
export function createWebSkills(options: { pathEnv: PathEnv; reviewer?: SkillModelReviewer | undefined; fetch?: FetchOptions | undefined }): SkillService {
  const { pathEnv } = options;
  return new SkillService({
    libraryDir: async () => resolvePaths(await readConfig(configFilePath(pathEnv)), pathEnv).libraryDir,
    reviewer: options.reviewer ?? new SdkSkillReviewer({ pathEnv }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

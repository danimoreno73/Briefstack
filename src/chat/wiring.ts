import path from 'node:path';
import { resolveHome, type PathEnv } from '../config/index.js';
import type { CreationManager } from '../creation/manager.js';
import { planUsageReader } from '../creation/planUsage.js';
import type { Lang } from '../i18n/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { loadUsageContext, resolveActiveProfile } from '../usage/index.js';
import { ChatManager } from './manager.js';
import { SdkChatRunner } from './sdkChatRunner.js';
import { ChatStore } from './store.js';
import type { ChatRunner } from './types.js';

export interface WebChatOptions {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
  lang: Lang;
  creations?: CreationManager | undefined;
  /** The real SDK runner unless one is passed; tests pass the fake one. */
  runner?: ChatRunner | undefined;
  /** Plan usage for `show_usage`; the real reading with the real runner. */
  planUsage?: (() => Promise<{ fiveHour: number | null; sevenDay: number | null } | undefined>) | undefined;
  idleMs?: number;
}

/** The chat's model and effort from the active usage profile (BRIEF-phase-4 §8.3). */
export async function activeChatProfile(pathEnv: PathEnv): Promise<{ model: string; effort: string }> {
  const { config, profiles } = await loadUsageContext(pathEnv);
  return { ...resolveActiveProfile(config, profiles).preset.chat };
}

/** The chat `briefstack web` gives the server: history under `<home>/chat`, the real runner unless one is passed. */
export async function createWebChat(options: WebChatOptions): Promise<ChatManager> {
  const { pathEnv } = options;
  const repoDir = options.repoDir ?? PACKAGE_ROOT;
  const runner = options.runner ?? new SdkChatRunner({ pathEnv });
  const planUsage = options.planUsage ?? (options.runner === undefined ? planUsageReader({ pathEnv, repoDir }) : undefined);
  return ChatManager.open({
    store: new ChatStore(path.join(resolveHome(pathEnv), 'chat')),
    runner,
    tools: { pathEnv, repoDir, lang: options.lang, creations: options.creations, planUsage },
    profile: () => activeChatProfile(pathEnv),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
}

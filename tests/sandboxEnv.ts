import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Points everything briefstack reads from the environment at a temp folder,
 * so that no test can reach the developer's real data even when
 * `BRIEFSTACK_HOME` is set for the user. Returns a function that removes it.
 */
export function isolateEnvironment(options: { appData?: boolean } = {}): () => void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'briefstack-sandbox-'));
  const user = path.join(root, 'user');
  mkdirSync(user, { recursive: true });
  process.env.BRIEFSTACK_HOME = path.join(root, 'home');
  delete process.env.BRIEFSTACK_LIBRARY;
  delete process.env.CLAUDE_CONFIG_DIR;
  // os.homedir() reads these, and the default projects folder hangs off it.
  process.env.USERPROFILE = user;
  process.env.HOME = user;
  if (options.appData === true) {
    // Protected folders (`protectedDirs`). On Windows the system temp folder is inside the real
    // %LOCALAPPDATA%, so every temp folder a test uses would count as protected. Playwright keeps
    // its browsers under %LOCALAPPDATA%, so its runner does not move them.
    process.env.APPDATA = path.join(root, 'appdata-roaming');
    process.env.LOCALAPPDATA = path.join(root, 'appdata-local');
  }
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

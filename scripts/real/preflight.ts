// Before H10 (the real run from the browser), print what it will use, so the
// user can see it is the right data. Reads only: it creates nothing, writes
// nothing and starts no conversation. The plan usage is read the way `/usage`
// does, from a session that sends no message (it costs nothing). The git
// commands use --no-optional-locks, so not even the index is refreshed.
// Run:  npx tsx scripts/real/preflight.ts

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { configFilePath, readConfig, resolvePaths, systemPathEnv } from '../../src/config/index.js';
import { checkClaudeCode, formatVersion } from '../../src/creation/claudeBinary.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { hasPlanLimits, keySourceLabel, readAuthMode } from '../../src/creation/claudeAccount.js';
import { GIT_STATUS_ARGS, claudeExecutable, readPlanUsage, sandbox, sessionEnv, show, startCheck } from './common.js';

const run = promisify(execFile);
const pathEnv = systemPathEnv();
const paths = resolvePaths(await readConfig(configFilePath(pathEnv)), pathEnv);

console.log('BRIEFSTACK_HOME :', process.env.BRIEFSTACK_HOME ?? '(not set: the default home is used)');
console.log('home            :', paths.home);
console.log('library         :', paths.libraryDir);
console.log('projects folder :', paths.projectsDir);
console.log('sessions        :', paths.sessionsDir);

const claude = await checkClaudeCode({ env: process.env, platform: process.platform, homedir: os.homedir() });
console.log('claude          :', claude.status === 'notFound' ? 'NOT FOUND' : `${claude.executable} (${claude.status}${'installed' in claude ? `, ${formatVersion(claude.installed)}` : ''})`);
const git = await run('git', [...GIT_STATUS_ARGS], { cwd: PACKAGE_ROOT });
console.log('repo            :', git.stdout.trim() === '' ? 'clean' : 'HAS UNCOMMITTED CHANGES');
const library = await run('git', [...GIT_STATUS_ARGS], { cwd: paths.libraryDir }).catch(() => undefined);
console.log('library git     :', library === undefined ? 'not a git repo or missing' : library.stdout.trim() === '' ? 'clean' : 'HAS UNCOMMITTED CHANGES');

if (claude.status !== 'notFound') {
  const check = startCheck();
  try {
    const box = await sandbox('preflight');
    check.add(() => box.cleanup());
    // How Claude Code signs in, as it reports it: the kind only, never an account detail or a secret.
    const mode = await readAuthMode({ cwd: box.project, executable: claudeExecutable(), env: sessionEnv(box) });
    console.log('sign-in         :', mode.kind === 'signIn' ? `Claude plan${mode.plan === undefined ? '' : ` (${mode.plan})`}` : mode.kind === 'apiKey' ? `API key (${keySourceLabel(mode.source)})` : mode.kind === 'cloud' ? `cloud provider (${mode.provider})` : mode.kind === 'none' ? 'NOT SIGNED IN' : 'unknown');
    console.log('plan usage      :', hasPlanLimits(mode) ? show(await readPlanUsage(box, claudeExecutable())) : 'not shown: no plan limits in this mode');
  } catch (error) {
    check.fail(error);
  } finally {
    await check.close();
  }
  process.exit(check.exitCode(true));
}

// Before H10 (the real run from the browser), print what it will use, so the
// user can see it is the right data. Reads only: it creates nothing, writes
// nothing and starts no conversation. The plan usage is read the way `/usage`
// does, from a session that sends no message (it costs nothing).
// Run:  npx tsx scripts/real/preflight.ts

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { configFilePath, readConfig, resolvePaths, systemPathEnv } from '../../src/config/index.js';
import { checkClaudeCode, formatVersion } from '../../src/creation/claudeBinary.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, readPlanUsage, sandbox, show } from './common.js';

const run = promisify(execFile);
const pathEnv = systemPathEnv();
const paths = resolvePaths(await readConfig(configFilePath(pathEnv)), pathEnv);

console.log('BRIEFSTACK_HOME :', process.env.BRIEFSTACK_HOME ?? '(not set: the default home is used)');
console.log('home            :', paths.home);
console.log('library         :', paths.libraryDir);
console.log('projects folder :', paths.projectsDir);
console.log('sessions        :', paths.sessionsDir);

const check = await checkClaudeCode({ env: process.env, platform: process.platform, homedir: os.homedir() });
console.log('claude          :', check.status === 'notFound' ? 'NOT FOUND' : `${check.executable} (${check.status}${'installed' in check ? `, ${formatVersion(check.installed)}` : ''})`);
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  if (process.env[name] !== undefined) console.log(`WARNING         : ${name} is set; briefstack web does not pass it to Claude Code.`);
}
const git = await run('git', ['status', '--porcelain'], { cwd: PACKAGE_ROOT });
console.log('repo            :', git.stdout.trim() === '' ? 'clean' : 'HAS UNCOMMITTED CHANGES');
const library = await run('git', ['status', '--porcelain'], { cwd: paths.libraryDir }).catch(() => undefined);
console.log('library git     :', library === undefined ? 'not a git repo or missing' : library.stdout.trim() === '' ? 'clean' : 'HAS UNCOMMITTED CHANGES');

if (check.status !== 'notFound') {
  const box = await sandbox('preflight');
  try {
    console.log('plan usage      :', show(await readPlanUsage(box, claudeExecutable())));
  } finally {
    await box.cleanup();
  }
}

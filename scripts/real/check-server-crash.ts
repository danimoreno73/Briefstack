// Real check (docs/decisions.md, "If `briefstack web` crashes"): a server
// that dies while a creation's tool call waits on it leaves no process
// running and no write outside the allowed folders.
//
// Everything happens in a temp work folder (`sandbox()` in common.ts, with a
// temp BRIEFSTACK_HOME, its own library, projects and sessions); the real
// library and projects are not touched. Two cheap real creations on the
// saver profile, each only until its first question:
//
//   A. Hard kill. It starts the real `briefstack web` (from the sources) in
//      its own process, starts a creation through the HTTP API, and once the
//      creation asks a question it ends that server at once, without its
//      children (`taskkill /F` without `/T`, or SIGKILL). It watches for a
//      minute, then runs `briefstack web` again, whose start sweeps the run
//      files. Expected: the command-hook guard ran in the session (its
//      `guard.log`); after the restart no process mentions the work folder;
//      the run folder is gone; the session is closed as interrupted.
//      Whether `claude` was still running before the restart is printed as
//      information (on Windows libuv's job object usually ends it with the
//      server).
//   B. Uncaught exception. The creation manager runs in a process that
//      throws once the creation asks a question
//      (`scripts/real/fixtures/crash-throw.ts`). Expected: no process
//      mentions the work folder, before any restart (the exit hook of
//      `spawnTracked`); a restart then closes the session.
//
// In both, the idea asks for a copy in a folder outside the allowed ones.
// At the end: no file appeared in the work folder outside the projects
// folder and the temp home, and the repo's git status did not change.
//
// The agent files in `.claude/agents/` must hold the saver models (this
// script never rewrites them; see check-two-creations.ts). Plan usage is
// printed before and after; above 70% of the 5-hour window it does not
// start. It stops after 30 minutes.
// Run:  npx tsx scripts/real/check-server-crash.ts --yes

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { systemPathEnv, updateConfig } from '../../src/config/index.js';
import { killProcessTree } from '../../src/creation/processTree.js';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { TOKEN_HEADER } from '../../src/server/index.js';
import { agentSetting, baseProfilesFile, loadUsageProfiles } from '../../src/usage/index.js';
import {
  CheckStop,
  GIT_STATUS_ARGS,
  claudeExecutable,
  filesOutside,
  hardKill,
  processesMentioning,
  readPlanUsage,
  report,
  requireConfirmation,
  sandbox,
  sandboxLibrary,
  show,
  startCheck,
  type Sandbox,
} from './common.js';

requireConfirmation('Kill a briefstack web twice while a real creation waits on it (saver profile, two short creations), in a temp home.');

const LIMIT_MS = 30 * 60_000;
const PENDING_MS = 10 * 60_000;
const WATCH_MS = 60_000;

// The agent files must already hold the saver models: this script never rewrites them.
const profiles = await loadUsageProfiles({ baseFile: baseProfilesFile() });
const saver = profiles.presets.saver;
if (saver === undefined) throw new Error('no saver preset');
const mismatched: string[] = [];
for (const agent of ['interviewer', 'researcher', 'architect', 'generator', 'reviewer']) {
  const file = path.join(PACKAGE_ROOT, '.claude', 'agents', `${agent}.md`);
  const { data } = parseFrontmatter(await readFile(file, 'utf8'), file);
  if (data.model !== agentSetting(saver, agent)?.model) mismatched.push(`${agent}: ${String(data.model)}`);
}
if (mismatched.length > 0) {
  console.error(`The agent files do not hold the saver profile (${mismatched.join(', ')}).`);
  console.error('Run  npm run briefstack -- usage set saver  first, and  usage set <your profile>  afterwards.');
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The `claude` pids and session ids the run files of the temp home name, and their guard logs. */
async function runFiles(box: Sandbox): Promise<{ creationId: string; claudePid?: number; sessionId?: string; guardLog: string }[]> {
  const runsDir = path.join(box.home, 'runs');
  const found = [];
  for (const name of await readdir(runsDir).catch(() => [] as string[])) {
    const record = JSON.parse(await readFile(path.join(runsDir, name, 'run.json'), 'utf8').catch(() => '{}')) as {
      claude?: { pid?: number };
      sessionId?: string;
    };
    const guardLog = await readFile(path.join(runsDir, name, 'guard.log'), 'utf8').catch(() => '');
    found.push({
      creationId: name,
      ...(record.claude?.pid === undefined ? {} : { claudePid: record.claude.pid }),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      guardLog,
    });
  }
  return found;
}

/** Runs `briefstack web` in this process just long enough for its start: the sweep of the run files. */
async function restart(): Promise<string[]> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd: PACKAGE_ROOT,
    pathEnv: systemPathEnv(),
    untilStopped: async () => undefined,
    checkClaude: async () => ({ status: 'compatible', executable: 'claude', installed: [0, 0, 0], expected: [0, 0, 0] }),
  };
  const code = await main(['web', '--port', '0'], io);
  if (code !== 0) throw new Error(`briefstack web did not start again (exit ${code}): ${err.join(' | ')}`);
  return err;
}

/** Waits until no process mentions the work folder; returns what is left. */
async function leftover(box: Sandbox, waitMs: number): Promise<{ pid: number; command: string }[]> {
  const deadline = Date.now() + waitMs;
  let left = await processesMentioning(box.dir);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(1000);
    left = await processesMentioning(box.dir);
  }
  return left;
}

const sessionEnds = async (box: Sandbox, sessionId: string | undefined): Promise<string> =>
  sessionId === undefined
    ? ''
    : (await readFile(path.join(box.sessions, sessionId, 'events.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line.includes('"session.end"'))
        .join('\n');

const describe = (left: { pid: number; command: string }[]) =>
  left.map((entry) => `${entry.pid}: ${entry.command.slice(0, 160)}`).join(' | ') || 'none';

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('server-crash');
  check.add(() => box.cleanup());
  // Last resort, before the sandbox goes: end anything still running from it.
  check.add(async () => {
    for (const entry of await processesMentioning(box.dir)) await killProcessTree(entry.pid);
  });
  const finishBy = Date.now() + LIMIT_MS;

  const before = await readPlanUsage(box, executable);
  console.log(`Plan usage before: ${show(before)}`);
  if (typeof before !== 'string' && (before.fiveHour ?? 0) > 70) throw new CheckStop(2, 'The 5-hour window is above 70%: not starting.');
  await sandboxLibrary(box);
  await updateConfig(path.join(box.home, 'config.json'), { activeProfile: 'saver', permissionPolicy: 'ask' });
  const outside = path.join(box.dir, 'outside');
  await mkdir(outside, { recursive: true });
  const allowed = [box.projects, box.home];
  const filesBefore = await filesOutside(box.dir, allowed);
  const gitBefore = execFileSync('git', [...GIT_STATUS_ARGS], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  const idea = (what: string) =>
    `${what} Keep it minimal. Before anything else, save a copy of this idea to ${path.join(outside, 'idea.txt').replaceAll('\\', '/')}.`;

  // ---- A. Hard kill of the real briefstack web ----
  console.log('\nA. Hard kill of briefstack web');
  const server: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(PACKAGE_ROOT, 'src', 'cli.ts'), 'web', '--port', '0'], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  check.add(() => (server.pid === undefined ? undefined : killProcessTree(server.pid)));
  let serverOut = '';
  server.stdout?.setEncoding('utf8').on('data', (chunk: string) => (serverOut += chunk));
  server.stderr?.setEncoding('utf8').on('data', (chunk: string) => (serverOut += chunk));
  let address: URL | undefined;
  for (let i = 0; i < 120 && address === undefined; i += 1) {
    const match = /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/.exec(serverOut);
    if (match !== null) address = new URL(match[0]);
    else await sleep(500);
  }
  if (address === undefined) throw new Error(`briefstack web did not print its address: ${serverOut.slice(0, 500)}`);
  const url = address;
  const token = url.hash.replace('#token=', '');
  const call = (method: string, route: string, body?: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(url.port),
          path: route,
          method,
          headers: { host: url.host, [TOKEN_HEADER]: token, origin: url.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const created = await call('POST', '/api/creations', { idea: idea('A one-page checklist for packing a carry-on bag.') });
  if (created.status !== 200 && created.status !== 201) throw new Error(`could not start the creation: ${created.status} ${created.body}`);
  const { id } = JSON.parse(created.body) as { id: string };
  let state: { status?: string; pending?: { kind: string }; sessionId?: string } = {};
  const pendingBy = Math.min(Date.now() + PENDING_MS, finishBy);
  while (state.pending === undefined && state.status !== 'finished' && Date.now() < pendingBy) {
    await sleep(2000);
    state = JSON.parse((await call('GET', `/api/creations/${id}`)).body) as typeof state;
  }
  ok = report('A: the creation asked something (a tool call waits on the server)', state.pending !== undefined, state.pending?.kind ?? state.status ?? '?') && ok;
  const runsA = await runFiles(box);
  const guardLines = runsA.flatMap((run) => run.guardLog.split('\n').filter((line) => line.trim() !== ''));
  ok = report('A: the command-hook guard ran in the session', guardLines.length > 0, `${guardLines.length} line(s) in guard.log`) && ok;
  for (const line of guardLines.filter((entry) => entry.includes('"deny"'))) console.log(`   guard denied: ${line.slice(0, 200)}`);
  const claudeA = runsA.flatMap((run) => (run.claudePid === undefined ? [] : [run.claudePid]));
  ok = report('A: a run file names the claude process', claudeA.length === 1, claudeA.join(', ') || 'none') && ok;
  const sessionA = runsA[0]?.sessionId ?? state.sessionId;

  if (server.pid !== undefined) await hardKill(server.pid);
  console.log(`Killed briefstack web (pid ${server.pid ?? '?'}) without its children. Watching for ${WATCH_MS / 1000} s...`);
  const watchUntil = Date.now() + WATCH_MS;
  let stillRunning = false;
  while (Date.now() < watchUntil) {
    if (claudeA.some(alive)) stillRunning = true;
    await sleep(5000);
  }
  console.log(`Info: claude ${stillRunning || claudeA.some(alive) ? 'WAS still running' : 'was gone'} after the hard kill, before the restart.`);
  console.log(`Info: processes mentioning the work folder before the restart: ${describe(await processesMentioning(box.dir))}`);
  for (const line of await restart()) console.log(`   restart: ${line}`);
  ok = report('A: after the restart no process mentions the work folder', (await leftover(box, 20_000)).length === 0, describe(await processesMentioning(box.dir))) && ok;
  ok = report('A: the run folder is gone', (await runFiles(box)).length === 0, '') && ok;
  const endsA = await sessionEnds(box, sessionA);
  ok = report('A: the session is closed as interrupted', /server_crash|server_stop/.test(endsA), endsA || `no session.end (${sessionA ?? 'no session id'})`) && ok;

  // ---- B. Uncaught exception in the process that runs the creations ----
  console.log('\nB. Uncaught exception');
  const fixture = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(PACKAGE_ROOT, 'scripts', 'real', 'fixtures', 'crash-throw.ts'), idea('A tiny template for weekly reading notes.')],
    { cwd: PACKAGE_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  check.add(() => (fixture.pid === undefined || fixture.exitCode !== null ? undefined : killProcessTree(fixture.pid)));
  let fixtureOut = '';
  fixture.stdout?.setEncoding('utf8').on('data', (chunk: string) => (fixtureOut += chunk));
  fixture.stderr?.setEncoding('utf8').on('data', (chunk: string) => (fixtureOut += chunk));
  const exited = await Promise.race([
    new Promise<number | null>((resolve) => fixture.on('exit', (code) => resolve(code))),
    sleep(Math.max(0, Math.min(PENDING_MS + 60_000, finishBy - Date.now()))).then(() => 'timeout' as const),
  ]);
  const last = /\{"pending":.*\}/.exec(fixtureOut)?.[0] ?? '';
  const asked = (JSON.parse(last === '' ? '{}' : last) as { pending?: string | null; sessionId?: string | null });
  ok = report('B: the creation asked something before the crash', typeof asked.pending === 'string', last || fixtureOut.slice(-300)) && ok;
  ok = report('B: the process died of the exception', exited !== 'timeout' && exited !== 0 && fixtureOut.includes('crash on purpose'), String(exited)) && ok;
  ok = report('B: no process mentions the work folder, before any restart', (await leftover(box, 20_000)).length === 0, describe(await processesMentioning(box.dir))) && ok;
  for (const line of await restart()) console.log(`   restart: ${line}`);
  const endsB = await sessionEnds(box, asked.sessionId ?? undefined);
  ok = report('B: the session is closed as interrupted after the restart', /server_crash|server_stop/.test(endsB), endsB || 'no session.end') && ok;

  // ---- Writes ----
  const filesAfter = await filesOutside(box.dir, allowed);
  const added = filesAfter.filter((file) => !filesBefore.includes(file));
  ok = report('nothing was written in the work folder outside the projects folder and the temp home', added.length === 0, added.join(', ') || 'none') && ok;
  const gitAfter = execFileSync('git', [...GIT_STATUS_ARGS], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  ok = report('the repo git status did not change', gitAfter === gitBefore, gitAfter.trim() || 'clean') && ok;
  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

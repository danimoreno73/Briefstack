// Phase 5 H0 probes (BRIEF-phase-5 §6). Probes 1 and 3 START REAL CLAUDE CODE
// SESSIONS on haiku with low effort and a small maxTurns; probes 2 and 4 run
// no model. Everything happens in a sandbox (a temp BRIEFSTACK_HOME and temp
// folders under BRIEFSTACK_REAL_WORKDIR): the repo is cloned into it, and the
// worktrees are made from that clone, never from the real repo. Before and
// after each model probe the plan usage is read; above 85% of the 5-hour
// window the script stops.
//
//   npx tsx scripts/real/probe-h0-phase5.ts --yes --probe 1|2|3|4|all
//
// 1. A session whose working folder is a git worktree outside the repo folder,
//    with a guard (a callback and a command hook) limited to that worktree:
//    writes only to allowlisted paths in it, reads only in it and in an
//    evidence folder, no shell.
// 2. Build, lint and tests in a worktree whose node_modules is a link to the
//    clone's, with no network (proxy variables point at a closed port), and
//    how long each takes.
// 3. When Claude Code reads agent and skill files: an agent and a skill are
//    run, their bodies are edited (and a new agent added) mid-session, and
//    they are run again in the same session.
// 4. Committing only body changes of an agent file whose frontmatter holds
//    uncommitted `usage set` changes: git plumbing with a temporary index, a
//    compare-and-swap ref update, a three-way merge of the body when master
//    moved, and the same for a revert.

import { query, type HookCallback, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, systemPathEnv } from '../../src/config/index.js';
import { spawnTracked } from '../../src/creation/processTree.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck, type Sandbox } from './common.js';

requireConfirmation('Phase 5 H0 probes (haiku, low effort, a few short turns; a temp clone of the repo).');

const argIndex = process.argv.indexOf('--probe');
const which = argIndex >= 0 ? (process.argv[argIndex + 1] ?? 'all') : 'all';
const LIMIT = 85;
const MODEL_PROBES = new Set(['1', '3']);
const pathEnv = systemPathEnv();

let executable = '';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(file: string, args: readonly string[], cwd: string, options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        timeout: options.timeoutMs ?? 120_000,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // npm is a .cmd on Windows.
        shell: process.platform === 'win32' && file === 'npm',
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', ms: Date.now() - started });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function git(cwd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  const result = await run('git', args, cwd, options);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** A prompt queue that stays open until closed, like the runner's. */
class Queue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;
  push(text: string): void {
    const item: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

async function guardUsage(box: Sandbox, label: string): Promise<boolean> {
  const usage = await readPlanUsage(box, executable);
  console.log(`Plan usage ${label}: ${show(usage)}`);
  if (typeof usage !== 'string' && (usage.fiveHour ?? 0) > LIMIT) {
    console.log(`STOP: the 5-hour window is above ${LIMIT}%.`);
    return false;
  }
  return true;
}

const resultText = (m: SDKMessage): string => ('result' in m && typeof m.result === 'string' ? m.result : '');
const slash = (p: string): string => p.replaceAll('\\', '/');

// --- Shared: a clone of the repo and worktrees made from it ---------------------

let clonePromise: Promise<string> | undefined;

/** A clone of the repo's HEAD in the sandbox. Only reads the real repo. */
function cloneOf(box: Sandbox): Promise<string> {
  clonePromise ??= (async () => {
    const clone = path.join(box.dir, 'clone');
    await git(box.dir, ['clone', '--quiet', '--no-hardlinks', PACKAGE_ROOT, clone]);
    await git(clone, ['config', 'user.name', 'probe']);
    await git(clone, ['config', 'user.email', 'probe@example.invalid']);
    console.log(`clone at ${await git(clone, ['rev-parse', '--short', 'HEAD'])}`.trim());
    return clone;
  })();
  return clonePromise;
}

async function worktree(box: Sandbox, name: string): Promise<string> {
  const clone = await cloneOf(box);
  const dir = path.join(box.dir, `wt-${name}`);
  await git(clone, ['worktree', 'add', '--quiet', '-b', `improve/${name}`, dir, 'HEAD']);
  return dir;
}

// --- Probe 1 -----------------------------------------------------------------

/** The prototype allowlist: what an improvement session may write, relative to the worktree. */
function allowlisted(relative: string): boolean {
  const rel = slash(relative);
  return /^\.claude\/agents\/[a-z-]+\.md$/.test(rel) || rel === '.claude/skills/new-project/SKILL.md' || /^library\/[^]*$/.test(rel);
}

const COMMAND_HOOK = `
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const [rules, log] = process.argv.slice(2);
const { worktree } = JSON.parse(readFileSync(rules, 'utf8'));
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (p) => { const rel = path.relative(fold(worktree), fold(path.resolve(p))); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const target = input.tool_input?.file_path ?? input.tool_input?.path;
let code = 0;
if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name) && (typeof target !== 'string' || !inside(target))) code = 2;
appendFileSync(log, JSON.stringify({ tool: input.tool_name, cwd: input.cwd, code }) + '\\n');
if (code === 2) process.stderr.write('command guard: outside the worktree');
process.exit(code);
`;

async function probe1(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 1: a session in a worktree outside the repo, guarded ==');
  const clone = await cloneOf(box);
  const wt = await worktree(box, 'probe1');
  const evidence = path.join(box.dir, 'evidence');
  await mkdir(evidence, { recursive: true });
  const word = `osprey${randomInt(1000, 10000)}`;
  await writeFile(path.join(evidence, 'lesson.md'), `# Lesson\n\nThe word is ${word}.\n`, 'utf8');
  const hookFile = path.join(box.dir, 'guard-hook.mjs');
  const rulesFile = path.join(box.dir, 'guard-rules.json');
  const hookLog = path.join(box.dir, 'guard-hook.log');
  await writeFile(hookFile, COMMAND_HOOK, 'utf8');
  await writeFile(rulesFile, JSON.stringify({ worktree: wt }), 'utf8');

  const decisions: string[] = [];
  const asked: string[] = [];
  const realWt = path.resolve(wt);
  const readRoots = [realWt, path.resolve(evidence)];
  /** Why a write is refused, or undefined when it is an allowlisted file inside the worktree. */
  const writeRefusal = (value: unknown): string | undefined => {
    const target = typeof value === 'string' ? value : '';
    if (!path.isAbsolute(target)) return 'Use an absolute path inside the worktree.';
    const full = path.resolve(target);
    if (!isPathInside(full, realWt, pathEnv)) return 'Writes are only allowed inside the worktree.';
    const rel = path.relative(realWt, full);
    if (/(^|[\\/])\.git([\\/]|$)/i.test(rel) || !allowlisted(rel)) return `${slash(rel)} is not a file an improvement may change.`;
    return undefined;
  };
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const fields = (input.tool_input ?? {}) as Record<string, unknown>;
    const deny = (why: string) => {
      decisions.push(`${tool}:deny`);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
    };
    const allow = () => {
      decisions.push(`${tool}:allow`);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'improvement guard' } };
    };
    if (tool === 'Write' || tool === 'Edit') {
      const why = writeRefusal(fields.file_path);
      return why === undefined ? allow() : deny(why);
    }
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
      const target = typeof fields.file_path === 'string' ? fields.file_path : typeof fields.path === 'string' ? fields.path : wt;
      const full = path.resolve(wt, target);
      if (!readRoots.some((root) => full === root || isPathInside(full, root, pathEnv))) return deny('Reads are only allowed in the worktree and the evidence.');
      return allow();
    }
    return deny(`The tool ${tool} is not available here.`);
  };

  const before = await git(clone, ['status', '--porcelain']);
  const tracked = spawnTracked();
  const options: Options = {
    cwd: wt,
    pathToClaudeCodeExecutable: executable,
    env: sessionEnv(box),
    settingSources: [],
    model: 'haiku',
    effort: 'low',
    strictMcpConfig: true,
    persistSession: false,
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    additionalDirectories: [evidence],
    permissionMode: 'default',
    // Claude Code asks for a write in `.claude/` even when a hook allowed it: the same check answers here.
    canUseTool: async (name, toolInput, extra) => {
      asked.push(`${name}(${JSON.stringify(extra.decisionReason ?? null).slice(0, 200)})`);
      if ((name === 'Write' || name === 'Edit') && writeRefusal(toolInput.file_path) === undefined) return { behavior: 'allow', updatedInput: toolInput };
      return { behavior: 'deny', message: 'Not allowed.' };
    },
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    settings: {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: process.execPath, args: [hookFile, rulesFile, hookLog], onFailure: 'block', timeout: 30 }] }],
      },
    } as unknown as NonNullable<Options['settings']>,
    maxTurns: 14,
    spawnClaudeCodeProcess: (o) => tracked.spawn(o),
  };
  const researcher = slash(path.join(wt, '.claude', 'agents', 'researcher.md'));
  const prompt = [
    'Do these steps in order, each one once, even if an earlier one failed:',
    `1) Read the file ${slash(path.join(evidence, 'lesson.md'))} and note the word in it.`,
    `2) Read the file ${slash(path.join(clone, 'README.md'))}.`,
    `3) Read ${researcher}, then use the Edit tool on it to add a last line "PROBE-OK <the word>" at the end of the file.`,
    `4) Write a new file ${slash(path.join(wt, 'src', 'probe.ts'))} containing: export {};`,
    `5) Write a new file ${slash(path.join(clone, 'library', 'probe.md'))} containing: probe`,
    '6) Run the shell command `echo hi`.',
    'Then reply with the word and, for each step, one word: done, denied or unavailable.',
  ].join('\n');
  let initTools: string[] = [];
  let initCwd = '';
  let final = '';
  const started = Date.now();
  const q = check.query(query({ prompt, options }), tracked);
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init' && initTools.length === 0) {
      initTools = m.tools;
      initCwd = m.cwd;
    }
    if (m.type === 'result') {
      final = resultText(m);
      break;
    }
  }
  q.close();
  await tracked.killTree();

  const researcherText = await readFile(researcher, 'utf8');
  const wtStatus = (await git(wt, ['status', '--porcelain', '--untracked-files=all'])).trim();
  const after = await git(clone, ['status', '--porcelain']);
  const hookLines = (await readFile(hookLog, 'utf8').catch(() => '')).trim().split('\n').filter((l) => l !== '');
  const hookEntries = hookLines.map((l) => JSON.parse(l) as { tool: string; cwd: string; code: number });
  const exists = (p: string) => stat(p).then(() => true, () => false);
  console.log(`init cwd: ${initCwd}; init tools: ${initTools.join(', ')}`);
  console.log(`guard decisions: ${decisions.join(', ')}; canUseTool: ${asked.join(', ') || 'none'}`);
  console.log(`command hook: ${hookLines.length} calls, ${JSON.stringify(hookEntries.slice(0, 8))}`);
  console.log(`worktree status: ${JSON.stringify(wtStatus)}; clone status before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  console.log(`final: ${final.slice(0, 400)}`);
  console.log(`elapsed ${Math.round((Date.now() - started) / 1000)} s`);
  let ok = true;
  ok = report('the session runs in the worktree', path.resolve(initCwd).toLowerCase() === realWt.toLowerCase(), initCwd) && ok;
  ok = report('only the five file tools are offered (no shell)', initTools.length === 5 && !initTools.some((t) => t === 'Bash' || t === 'PowerShell'), initTools.join(', ')) && ok;
  ok = report('the evidence outside the worktree was read', final.includes(word) && decisions.includes('Read:allow'), word) && ok;
  ok = report('a read outside the worktree and the evidence was denied', decisions.includes('Read:deny'), decisions.filter((d) => d.startsWith('Read')).join(', ')) && ok;
  ok = report('the allowlisted agent file was edited', researcherText.includes(`PROBE-OK ${word}`), 'researcher.md') && ok;
  ok = report('a non-allowlisted file in the worktree was not written', !(await exists(path.join(wt, 'src', 'probe.ts'))), 'src/probe.ts') && ok;
  ok = report('nothing was written outside the worktree', !(await exists(path.join(clone, 'library', 'probe.md'))) && before === after, 'clone unchanged') && ok;
  ok = report('the worktree changed only in the allowlisted file', wtStatus === 'M .claude/agents/researcher.md', wtStatus) && ok;
  ok = report('the command hook ran in the worktree', hookEntries.length > 0 && hookEntries.every((e) => path.resolve(e.cwd).toLowerCase() === realWt.toLowerCase()), String(hookEntries.length)) && ok;
  ok = report('canUseTool was reached only for allowlisted writes', asked.every((a) => a.startsWith('Edit(') || a.startsWith('Write(')), asked.join(', ') || 'none') && ok;
  return ok;
}

// --- Probe 2 -----------------------------------------------------------------

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

async function probe2(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 2: build, lint and tests in a worktree with linked node_modules ==');
  const clone = await cloneOf(box);
  // The clone's own node_modules, from the npm cache only. The real repo's is never linked or written.
  const install = await run('npm', ['ci', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], clone, { timeoutMs: 600_000 });
  console.log(`npm ci --offline in the clone: code ${install.code}, ${Math.round(install.ms / 1000)} s ${install.code === 0 ? '' : install.stderr.slice(-400)}`);
  if (install.code !== 0) return report('the clone has its own node_modules', false, 'npm ci --offline failed');
  const wt = await worktree(box, 'probe2');
  const modules = path.join(clone, 'node_modules');
  // A junction needs no rights on Windows; elsewhere a directory symlink.
  await symlink(modules, path.join(wt, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const dotBefore = (await listing(modules)).filter((n) => n.startsWith('.'));
  const viteBefore = await listing(path.join(modules, '.vite-temp'));
  // No network: every proxy points at a closed port, npm is offline.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '',
    npm_config_offline: 'true',
  };
  const steps: [string, string[]][] = [
    ['build', ['run', 'build']],
    ['lint', ['run', 'lint']],
    ['test', ['test']],
  ];
  let ok = true;
  for (const [name, args] of steps) {
    const result = await run('npm', args, wt, { env, timeoutMs: 600_000 });
    const tail = (result.stdout + result.stderr).trim().split('\n').slice(-4).join(' | ');
    ok = report(`${name} passes in the worktree`, result.code === 0, `${Math.round(result.ms / 1000)} s; ${tail.slice(0, 300)}`) && ok;
  }
  const dotAfter = (await listing(modules)).filter((n) => n.startsWith('.'));
  const viteAfter = await listing(path.join(modules, '.vite-temp'));
  console.log(`node_modules dot entries before ${dotBefore.join(',')} after ${dotAfter.join(',')}; .vite-temp before ${viteBefore.length} after ${viteAfter.length}`);
  const wtStatus = (await git(wt, ['status', '--porcelain', '--untracked-files=all'])).trim();
  ok = report('the worktree has no new tracked or untracked files', wtStatus === '', wtStatus.slice(0, 200)) && ok;
  return ok;
}

// --- Probe 3 -----------------------------------------------------------------

const agentFile = (name: string, reply: string) =>
  `---\nname: ${name}\ndescription: Replies with a fixed word. Use when asked to run ${name}.\ntools: Read\nmodel: haiku\n---\n\nIgnore the request and reply with exactly this word and nothing else: ${reply}\n`;
const skillFile = (reply: string) =>
  `---\nname: probe-skill\ndescription: Replies with a fixed word.\n---\n\nReply with exactly this word and nothing else: ${reply}\n`;

async function probe3(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 3: when agent and skill files are read ==');
  const dir = path.join(box.dir, 'p3');
  const agents = path.join(dir, '.claude', 'agents');
  const skill = path.join(dir, '.claude', 'skills', 'probe-skill');
  await mkdir(agents, { recursive: true });
  await mkdir(skill, { recursive: true });
  const n = randomInt(1000, 10000);
  const words = { agentA: `ALPHA${n}`, agentB: `BRAVO${n}`, skillA: `SKILLA${n}`, skillB: `SKILLB${n}`, late: `LATE${n}` };
  await writeFile(path.join(agents, 'echo-agent.md'), agentFile('echo-agent', words.agentA), 'utf8');
  await writeFile(path.join(skill, 'SKILL.md'), skillFile(words.skillA), 'utf8');

  const input = new Queue();
  const tracked = spawnTracked();
  const subagentStarts: string[] = [];
  const record: HookCallback = async (hook) => {
    if (hook.hook_event_name === 'SubagentStart') subagentStarts.push(hook.agent_type);
    return {};
  };
  const options: Options = {
    cwd: dir,
    pathToClaudeCodeExecutable: executable,
    env: sessionEnv(box),
    settingSources: ['project'],
    model: 'haiku',
    effort: 'low',
    strictMcpConfig: true,
    persistSession: false,
    tools: ['Agent', 'Skill', 'Read'],
    allowedTools: ['Agent', 'Skill'],
    permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'deny', message: 'Not allowed.' }),
    hooks: { SubagentStart: [{ hooks: [record] }] },
    maxTurns: 30,
    spawnClaudeCodeProcess: (o) => tracked.spawn(o),
  };
  const askAgent = (name: string) =>
    `Use the Agent tool with subagent_type "${name}" and the prompt "go". Then reply with exactly the word it returned, or NONE if the agent does not exist.`;
  const turns: { prompt: string; before?: () => Promise<void> }[] = [
    { prompt: askAgent('echo-agent') },
    { prompt: '/probe-skill' },
    {
      prompt: askAgent('echo-agent'),
      before: async () => {
        await writeFile(path.join(agents, 'echo-agent.md'), agentFile('echo-agent', words.agentB), 'utf8');
        await writeFile(path.join(skill, 'SKILL.md'), skillFile(words.skillB), 'utf8');
        await writeFile(path.join(agents, 'late-agent.md'), agentFile('late-agent', words.late), 'utf8');
        // The docs say a change is detected "within a few seconds".
        await new Promise((resolve) => setTimeout(resolve, 8000));
      },
    },
    { prompt: '/probe-skill' },
    { prompt: askAgent('late-agent') },
  ];
  const finals: string[] = [];
  let initAgents: unknown;
  let initSkills: unknown;
  input.push(turns[0]!.prompt);
  const q = check.query(query({ prompt: input, options }), tracked);
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init' && initAgents === undefined) {
      initAgents = (m as { agents?: unknown }).agents;
      initSkills = (m as { skills?: unknown }).skills;
    }
    if (m.type === 'result') {
      finals.push(resultText(m).trim());
      const next = turns[finals.length];
      if (next === undefined) break;
      await next.before?.();
      input.push(next.prompt);
    }
  }
  input.close();
  q.close();
  await tracked.killTree();
  console.log(`init agents: ${JSON.stringify(initAgents)}; skills: ${JSON.stringify(initSkills)}`);
  console.log(`subagent starts: ${subagentStarts.join(', ')}`);
  console.log(`finals: ${JSON.stringify(finals)}`);
  const has = (i: number, word: string) => (finals[i] ?? '').includes(word);
  let ok = true;
  ok = report('turn 1: the agent as it was at start', has(0, words.agentA), finals[0] ?? '') && ok;
  ok = report('turn 2: the skill as it was at start', has(1, words.skillA), finals[1] ?? '') && ok;
  // These three are findings, not requirements: the result decides the design.
  report('turn 3: the edited agent body is used by the next subagent start (finding)', has(2, words.agentB), finals[2] ?? '');
  report('turn 4: the edited skill body is used when invoked again (finding)', has(3, words.skillB), finals[3] ?? '');
  report('turn 5: an agent added mid-session can be started (finding)', has(4, words.late), finals[4] ?? '');
  return ok;
}

// --- Probe 4 -----------------------------------------------------------------

const AGENT_HEAD = (model: string) => `---\nname: demo\ndescription: A demo agent.\ntools: Read\nmodel: ${model}\neffort: medium\n---\n`;
const BODY = ['', 'Line one of the body.', 'Line two of the body.', 'Line three of the body.', 'Line four of the body.', 'Line five of the body.', 'Line six of the body.', 'Line seven of the body.', 'Line eight of the body.', 'Line nine of the body.', ''].join('\n');

/** Splits `---\n...\n---\n` from the rest. */
function split(text: string): { head: string; body: string } {
  const match = /^---\n[^]*?\n---\n/.exec(text);
  return match === null ? { head: '', body: text } : { head: match[0], body: text.slice(match[0].length) };
}

/** Three-way merge of one text with `git merge-file`: undefined on a conflict. */
async function merge3(cwd: string, ours: string, base: string, theirs: string): Promise<string | undefined> {
  const tmp = path.join(cwd, '..', `merge-${randomInt(1e9)}`);
  await mkdir(tmp, { recursive: true });
  const files = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
  await Promise.all([writeFile(files[0]!, ours), writeFile(files[1]!, base), writeFile(files[2]!, theirs)]);
  const result = await run('git', ['merge-file', '-p', ...files], tmp);
  await rm(tmp, { recursive: true, force: true });
  return result.code === 0 ? result.stdout : undefined;
}

/**
 * Applies new bodies to `paths` as one commit on `branch`, keeping each
 * file's committed frontmatter in the commit and its working frontmatter in
 * the working tree. `base` is the commit the bodies were prepared against.
 */
async function applyBodies(repo: string, branch: string, base: string, bodies: Record<string, string>, message: string): Promise<{ ok: true; commit: string } | { ok: false; reason: string }> {
  const head = (await git(repo, ['rev-parse', `refs/heads/${branch}`])).trim();
  const index = path.join(repo, '..', `index-${randomInt(1e9)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  await git(repo, ['read-tree', head], { env });
  const working: Record<string, string> = {};
  for (const [file, newBody] of Object.entries(bodies)) {
    const atHead = split(await git(repo, ['show', `${head}:${file}`]));
    const atBase = split(await git(repo, ['show', `${base}:${file}`]));
    const onDisk = split(await readFile(path.join(repo, file), 'utf8'));
    if (onDisk.body !== atHead.body) return { ok: false, reason: `${file} has uncommitted body changes` };
    const merged = await merge3(repo, atHead.body, atBase.body, newBody);
    if (merged === undefined) return { ok: false, reason: `${file} changed on ${branch} in the same lines` };
    const blob = (await git(repo, ['hash-object', '-w', '--stdin', `--path=${file}`], { input: atHead.head + merged })).trim();
    await git(repo, ['update-index', '--cacheinfo', `100644,${blob},${file}`], { env });
    working[file] = onDisk.head + merged;
  }
  const tree = (await git(repo, ['write-tree'], { env })).trim();
  await rm(index, { force: true });
  const commit = (await git(repo, ['commit-tree', tree, '-p', head, '-m', message])).trim();
  // Compare and swap: refused if the branch moved since `head` was read.
  await git(repo, ['update-ref', `refs/heads/${branch}`, commit, head]);
  for (const [file, text] of Object.entries(working)) {
    await writeFile(path.join(repo, file), text, 'utf8');
    // The real index follows the commit for this file, so the frontmatter change stays unstaged.
    const blob = (await git(repo, ['rev-parse', `${commit}:${file}`])).trim();
    await git(repo, ['update-index', '--cacheinfo', `100644,${blob},${file}`]);
  }
  return { ok: true, commit };
}

async function probe4(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 4: commit only body changes with uncommitted frontmatter ==');
  const repo = path.join(box.dir, 'p4', 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '--quiet', '-b', 'master']);
  await git(repo, ['config', 'user.name', 'probe']);
  await git(repo, ['config', 'user.email', 'probe@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  const file = '.claude/agents/demo.md';
  await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
  await writeFile(path.join(repo, file), AGENT_HEAD('opus') + BODY, 'utf8');
  await writeFile(path.join(repo, 'other.txt'), 'other\n', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '--quiet', '-m', 'start']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  // `usage set` rewrote the frontmatter and did not commit.
  await writeFile(path.join(repo, file), AGENT_HEAD('haiku') + BODY, 'utf8');
  // The proposal changes line two of the body.
  const proposed = BODY.replace('Line two of the body.', 'Line two, improved.');
  // master moved since the proposal: another file, then the same agent in another line.
  await writeFile(path.join(repo, 'other.txt'), 'other, changed\n', 'utf8');
  await git(repo, ['commit', '--quiet', '-m', 'unrelated', '--', 'other.txt']);

  let ok = true;
  const first = await applyBodies(repo, 'master', base, { [file]: proposed }, 'Apply improvement P1');
  ok = report('apply with uncommitted frontmatter', first.ok, first.ok ? first.commit.slice(0, 8) : first.reason) && ok;
  if (!first.ok) return false;
  const committed = await git(repo, ['show', `HEAD:${file}`]);
  const onDisk = await readFile(path.join(repo, file), 'utf8');
  const status = (await git(repo, ['status', '--porcelain'])).trimEnd();
  const unstaged = await git(repo, ['diff', '--', file]);
  const staged = await git(repo, ['diff', '--cached']);
  const changedInCommit = (await git(repo, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).trim();
  ok = report('the commit keeps the committed frontmatter and has the new body', committed === AGENT_HEAD('opus') + proposed, '') && ok;
  ok = report('the working file keeps the uncommitted frontmatter and has the new body', onDisk === AGENT_HEAD('haiku') + proposed, '') && ok;
  ok = report('git status shows the file modified, not staged', status === ' M .claude/agents/demo.md' && staged === '', JSON.stringify(status)) && ok;
  ok = report('the unstaged diff is the model line only', /^-model: opus$/m.test(unstaged) && /^\+model: haiku$/m.test(unstaged) && !unstaged.includes('Line two'), '') && ok;
  ok = report('the commit touches only the agent file', changedInCommit === file, changedInCommit) && ok;

  // A stale compare-and-swap is refused.
  const stale = await run('git', ['update-ref', 'refs/heads/master', base, base], repo);
  ok = report('update-ref refuses when master moved', stale.code !== 0, stale.stderr.trim().slice(0, 120)) && ok;

  // Master moves again in the same file, another line: still applies (three-way merge of the body).
  const applied = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const bodyB = BODY.replace('Line two of the body.', 'Line two, improved.').replace('Line five of the body.', 'Line five, edited by hand.');
  await writeFile(path.join(repo, file), AGENT_HEAD('opus') + bodyB, 'utf8');
  await git(repo, ['commit', '--quiet', '-m', 'hand edit', '--', file]);
  await writeFile(path.join(repo, file), AGENT_HEAD('haiku') + bodyB, 'utf8');
  const second = await applyBodies(repo, 'master', base, { [file]: BODY.replace('Line eight of the body.', 'Line eight, improved.') }, 'Apply improvement P2');
  const secondBody = split(await git(repo, ['show', `HEAD:${file}`])).body;
  ok = report('a body change in other lines merges', second.ok && secondBody.includes('Line eight, improved.') && secondBody.includes('Line five, edited by hand.') && secondBody.includes('Line two, improved.'), second.ok ? '' : second.reason) && ok;

  // The same lines changed on master: refused.
  const third = await applyBodies(repo, 'master', base, { [file]: BODY.replace('Line two of the body.', 'Line two, other text.') }, 'Apply improvement P3');
  ok = report('a body change in the same lines is refused', !third.ok, third.ok ? 'applied' : third.reason) && ok;

  // Revert P1: base = P1's body, target = its parent's body, onto the current HEAD.
  const parentBody = split(await git(repo, ['show', `${applied}~1:${file}`])).body;
  const revert = await applyBodies(repo, 'master', applied, { [file]: parentBody }, 'Revert improvement P1');
  const revertedBody = split(await git(repo, ['show', `HEAD:${file}`])).body;
  const finalDisk = await readFile(path.join(repo, file), 'utf8');
  ok = report('revert removes P1 only and keeps later changes', revert.ok && revertedBody.includes('Line two of the body.') && revertedBody.includes('Line eight, improved.') && revertedBody.includes('Line five, edited by hand.'), revert.ok ? '' : revert.reason) && ok;
  ok = report('after revert the working frontmatter is still the uncommitted one', split(finalDisk).head === AGENT_HEAD('haiku') && split(finalDisk).body === revertedBody, '') && ok;

  // An uncommitted body edit blocks the apply.
  await writeFile(path.join(repo, file), finalDisk.replace('Line three of the body.', 'Line three, local.'), 'utf8');
  const blocked = await applyBodies(repo, 'master', base, { [file]: BODY }, 'Apply improvement P4');
  ok = report('an uncommitted body change blocks the apply', !blocked.ok, blocked.ok ? 'applied' : blocked.reason) && ok;
  console.log((await git(repo, ['log', '--oneline'])).trim());
  return ok;
}

// --- Main ----------------------------------------------------------------------

const check = startCheck();
let ok = true;
try {
  executable = claudeExecutable();
  const box = await sandbox('h0-phase5');
  check.add(() => box.cleanup());
  const probes: [string, (b: Sandbox) => Promise<boolean>][] = [
    ['1', probe1],
    ['2', probe2],
    ['3', probe3],
    ['4', probe4],
  ];
  for (const [id, runProbe] of probes) {
    if (which !== 'all' && which !== id) continue;
    const model = MODEL_PROBES.has(id);
    if (model && !(await guardUsage(box, `before probe ${id}`))) {
      ok = false;
      break;
    }
    try {
      ok = (await runProbe(box)) && ok;
    } catch (error) {
      ok = report(`probe ${id}`, false, error instanceof Error ? (error.stack ?? error.message) : String(error)) && ok;
    }
    if (model && !(await guardUsage(box, `after probe ${id}`))) break;
  }
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

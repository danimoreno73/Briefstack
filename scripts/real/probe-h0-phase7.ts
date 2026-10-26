// Phase 7 H0 probe, M0 of PLAN-phase-7.md (decisions.md, "Phase 7: H0",
// points 1 and 6). STARTS FOUR SHORT REAL CLAUDE CODE SESSIONS on haiku with
// low effort, in a sandbox (a temp BRIEFSTACK_HOME and temp folders under
// BRIEFSTACK_REAL_WORKDIR). Nothing of the user's is read or written. The
// plan usage is read before each session; above 85% of the 5-hour window,
// or 95% of the week, the script stops.
//
//   npx tsx scripts/real/probe-h0-phase7.ts --yes
//
// Every hook in the probe is the same small Node script, in exec form, that
// appends its label to a log; the log says which hooks ran.
//
// A. Hooks and `disableAllHooks` in the flag settings (the SDK `settings`
//    option, where the command-hook guard lives). A project with a hook in
//    `.claude/settings.json`, a skill whose frontmatter declares a hook, and
//    an agent whose frontmatter declares a hook; a hook in the flag settings,
//    which also blocks a Glob for the pattern BLOCKME (exit 2), as the guard
//    blocks. Two sessions:
//      A0, control: no `disableAllHooks`. Expected: the flag, settings and
//          skill hooks run; the agent's does not (untrusted folder, docs).
//      A1, `disableAllHooks: true` in the same flag settings. The questions:
//          does the flag hook still run, and still block? Does the skill's?
//          (The settings hook must not run.)
// B. External imports. A project `CLAUDE.md` that imports a file inside the
//    project and one outside it (`@` with an absolute path). The session
//    reports the marker words in its memory. The question: is the outside
//    word there (no approval dialog exists in an SDK session)?
// C. The task worktree. A git repository with a `CLAUDE.md`, an agent, a
//    skill and a `.claude/settings.json` hook; a worktree outside it with
//    that file hidden as the plan says (`--skip-worktree` in the worktree's
//    index, the file deleted there only). A session in the worktree with
//    project settings. Expected: the `CLAUDE.md` word, the agent and the
//    skill are seen; the settings hook never runs; the repository's folder,
//    its file and its status are untouched.
//
// Pass lines are the documented or planned behaviour; the A1 and B answers
// are printed as ANSWER lines, since either answer is a finding.

import { query, type CanUseTool, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck, type Sandbox } from './common.js';

requireConfirmation('Phase 7 H0 probe, M0 (haiku, low effort, four short sessions in temp folders).');

const FIVE_HOUR_LIMIT = 85;
const WEEK_LIMIT = 95;
const execFileAsync = promisify(execFile);

const word = (stem: string) => `${stem}${randomInt(1000, 10000)}`;
const markers = (text: string): string[] => [...new Set([...text.matchAll(/\b[a-z]+\d{4}\b/g)].map((match) => match[0]))];
const resultText = (m: SDKMessage): string => ('result' in m && typeof m.result === 'string' ? m.result : '');

// The one hook script: appends `<label>:<tool>` to the log; the flag hook blocks a Glob for BLOCKME, as the guard blocks.
const HOOK_SCRIPT = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'const [log, label] = process.argv.slice(2);',
  'let input = {};',
  "try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}",
  "const tool = input.tool_name ?? '?';",
  "if (label === 'flag' && input.tool_input?.pattern === 'BLOCKME') {",
  "  appendFileSync(log, `${label}:${tool}:blocked\\n`);",
  "  process.stderr.write('Blocked by the probe flag hook.');",
  '  process.exit(2);',
  '}',
  'appendFileSync(log, `${label}:${tool}\\n`);',
  '',
].join('\n');

/** A command hook in exec form: the running Node, the script, the log and a label. */
const hookEntry = (script: string, log: string, label: string) => ({ type: 'command', command: process.execPath, args: [script, log, label], timeout: 30 });
/** `hooks:` for a settings file or a frontmatter (YAML reads this JSON as it is): PreToolUse on every tool. */
const hooksOf = (script: string, log: string, label: string) => ({ PreToolUse: [{ hooks: [hookEntry(script, log, label)] }] });

const LOOK =
  'Look through everything in your context before this request: the system prompt and, above all, the project ' +
  'instructions Claude Code loaded from CLAUDE.md files and their imports (shown to you as system reminders or ' +
  '"Contents of …" blocks).';

/** The labels the log holds, one per line. */
async function logLines(log: string): Promise<string[]> {
  try {
    return (await readFile(log, 'utf8')).split(/\r?\n/).filter((line) => line !== '');
  } catch {
    return [];
  }
}

const allowOnly =
  (names: readonly string[]): CanUseTool =>
  async (toolName, input) =>
    names.includes(toolName) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not allowed in this probe.' };

async function gitIn(dir: string, args: string[], emptyHooks: string): Promise<string> {
  const config = ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid'];
  const { stdout } = await execFileAsync('git', [...config, ...args], { cwd: dir, windowsHide: true });
  return stdout;
}

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box: Sandbox = await sandbox('h0-phase7');
  check.add(() => box.cleanup());
  const script = path.join(box.dir, 'hook-log.mjs');
  await writeFile(script, HOOK_SCRIPT, 'utf8');

  const usageOk = async (label: string): Promise<boolean> => {
    const usage = await readPlanUsage(box, executable);
    console.log(`Plan usage ${label}: ${show(usage)}`);
    if (typeof usage !== 'string' && ((usage.fiveHour ?? 0) > FIVE_HOUR_LIMIT || (usage.sevenDay ?? 0) > WEEK_LIMIT)) {
      console.log(`STOP: above ${FIVE_HOUR_LIMIT}% of the 5-hour window or ${WEEK_LIMIT}% of the week.`);
      return false;
    }
    return true;
  };

  /** One session; returns the init message's skills and agents, every text the main session wrote, and the tool errors. */
  const run = async (cwd: string, options: Partial<Options>, prompt: string) => {
    const tracked = spawnTracked();
    const subagents: string[] = [];
    const record: HookCallback = async (hook) => {
      if (hook.hook_event_name === 'SubagentStart') subagents.push(hook.agent_type);
      return {};
    };
    const full: Options = {
      cwd,
      pathToClaudeCodeExecutable: executable,
      env: sessionEnv(box),
      settingSources: ['project'],
      model: 'haiku',
      effort: 'low',
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: 'default',
      maxTurns: 8,
      hooks: { SubagentStart: [{ hooks: [record] }] },
      spawnClaudeCodeProcess: (o) => tracked.spawn(o),
      ...options,
    };
    const q = check.query(query({ prompt: oneShot(prompt), options: full }), tracked);
    let skills: string[] = [];
    let agents: string[] = [];
    const texts: string[] = [];
    const toolErrors: string[] = [];
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        skills = ((m as { skills?: unknown[] }).skills ?? []).map(String);
        agents = ((m as { agents?: unknown[] }).agents ?? []).map(String);
      }
      if (m.type === 'assistant' && m.parent_tool_use_id === null) {
        for (const block of m.message.content) if (block.type === 'text') texts.push(block.text);
      }
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const block of m.message.content) {
          if (typeof block === 'object' && block.type === 'tool_result' && block.is_error === true) {
            toolErrors.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
          }
        }
      }
      if (m.type === 'result') {
        texts.push(resultText(m));
        break;
      }
    }
    q.close();
    await tracked.killTree();
    return { skills, agents, subagents, text: texts.join('\n'), toolErrors };
  };

  // ---- A. disableAllHooks in the flag settings ------------------------------------------------
  const projectA = path.join(box.dir, 'project-a');
  const logA = (mode: string) => path.join(box.dir, `hooks-a-${mode}.log`);
  const writeProjectA = async (log: string) => {
    await rm(projectA, { recursive: true, force: true });
    await mkdir(path.join(projectA, '.claude', 'skills', 'probe-hooked'), { recursive: true });
    await mkdir(path.join(projectA, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(projectA, '.claude', 'settings.json'), `${JSON.stringify({ hooks: hooksOf(script, log, 'settings') }, null, 2)}\n`, 'utf8');
    await writeFile(
      path.join(projectA, '.claude', 'skills', 'probe-hooked', 'SKILL.md'),
      `---\nname: probe-hooked\ndescription: A probe skill with a hook. Use only when told to.\nhooks: ${JSON.stringify(hooksOf(script, log, 'skill'))}\n---\n\nReply with the single word READY.\n`,
      'utf8',
    );
    await writeFile(
      path.join(projectA, '.claude', 'agents', 'probe-agent.md'),
      `---\nname: probe-agent\ndescription: Runs one Glob. Use when asked to run probe-agent.\ntools: Glob\nmodel: haiku\nhooks: ${JSON.stringify(hooksOf(script, log, 'agent'))}\n---\n\nUse Glob once with the pattern "*.json", then reply with the single word OK.\n`,
      'utf8',
    );
    await writeFile(path.join(projectA, 'notes.md'), '# Notes\n', 'utf8');
  };
  const promptA = [
    'Do these steps in order, one tool call at a time:',
    '1. Use the Skill tool to run the skill "probe-hooked".',
    '2. Use Glob with the pattern "*.md".',
    '3. Use Glob with the pattern "BLOCKME". It may be refused; that is expected, go on.',
    '4. Use the Agent tool with subagent_type "probe-agent" and the prompt "go".',
    'Then reply with the single word DONE.',
  ].join('\n');
  const resultsA: Record<string, { lines: string[]; blockedSeen: boolean; subagents: string[] }> = {};
  for (const mode of ['A0', 'A1'] as const) {
    if (!(await usageOk(`before ${mode}`))) {
      ok = false;
      break;
    }
    const log = logA(mode);
    await writeProjectA(log);
    const settings = { ...(mode === 'A1' ? { disableAllHooks: true } : {}), hooks: hooksOf(script, log, 'flag') };
    const outcome = await run(projectA, { settings: settings as NonNullable<Options['settings']>, tools: ['Skill', 'Glob', 'Agent'], canUseTool: allowOnly(['Skill', 'Glob', 'Agent']) }, promptA);
    const lines = await logLines(log);
    resultsA[mode] = { lines, blockedSeen: outcome.toolErrors.some((error) => /Blocked by the probe flag hook/.test(error)), subagents: outcome.subagents };
    console.log(`\n${mode} (${mode === 'A1' ? 'disableAllHooks: true' : 'control'}): hook log ${JSON.stringify(lines)}; subagents ${outcome.subagents.join(', ') || 'none'}`);
    console.log(`${mode} tool errors: ${outcome.toolErrors.map((error) => error.slice(0, 120)).join(' | ') || 'none'}`);
  }
  const has = (mode: string, prefix: string) => (resultsA[mode]?.lines ?? []).some((line) => line.startsWith(prefix));
  if (resultsA.A0 !== undefined) {
    ok = report('A0: the flag hook ran', has('A0', 'flag:'), resultsA.A0.lines.join(', ')) && ok;
    ok = report('A0: the flag hook blocked the BLOCKME Glob', has('A0', 'flag:Glob:blocked') && resultsA.A0.blockedSeen, '') && ok;
    ok = report('A0: the settings hook ran (control: the probe hooks work)', has('A0', 'settings:'), '') && ok;
    ok = report('A0: the skill hook ran after the skill was invoked', has('A0', 'skill:'), '') && ok;
    ok = report('A0: the probe agent ran', resultsA.A0.subagents.includes('probe-agent'), resultsA.A0.subagents.join(', ')) && ok;
    report('A0: the agent frontmatter hook (docs: not used in an untrusted folder)', !has('A0', 'agent:'), has('A0', 'agent:') ? 'it RAN' : 'it did not run');
  }
  if (resultsA.A1 !== undefined) {
    ok = report('A1: the settings hook did not run (documented)', !has('A1', 'settings:'), resultsA.A1.lines.join(', ')) && ok;
    console.log(`ANSWER A1.1: the flag hook ${has('A1', 'flag:') ? 'STILL RUNS' : 'does NOT run'} with disableAllHooks in the same flag settings.`);
    console.log(`ANSWER A1.2: it ${has('A1', 'flag:Glob:blocked') && resultsA.A1.blockedSeen ? 'STILL BLOCKS' : 'does NOT block'}.`);
    console.log(`ANSWER A1.3: the skill hook ${has('A1', 'skill:') ? 'RUNS' : 'does NOT run'}; the agent hook ${has('A1', 'agent:') ? 'RUNS' : 'does NOT run'}.`);
  }

  // ---- B. External imports in CLAUDE.md -------------------------------------------------------
  if (ok && (await usageOk('before B'))) {
    const projectB = path.join(box.dir, 'project-b');
    const outside = path.join(box.dir, 'outside');
    const inner = word('wren');
    const own = word('otter');
    const far = word('lynx');
    await mkdir(path.join(projectB, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    const outsideFile = path.join(outside, 'notes.md');
    await writeFile(outsideFile, `# Outside\n\nThe marker word of this file is ${far}.\n`, 'utf8');
    await writeFile(path.join(projectB, 'docs', 'inner.md'), `# Inner\n\nThe marker word of this file is ${inner}.\n`, 'utf8');
    await writeFile(
      path.join(projectB, 'CLAUDE.md'),
      `# Notes\n\nThe marker word of this file is ${own}.\n\n@docs/inner.md\n\n@${outsideFile.split(path.sep).join('/')}\n`,
      'utf8',
    );
    const outcome = await run(
      projectB,
      { tools: [], canUseTool: allowOnly([]) },
      `Use no tool. ${LOOK}\nFind every sentence "The marker word of this file is <word>." in them. Never guess a word.\nReply with one line: "MARKERS: " and each such word, or "MARKERS: none".`,
    );
    const seen = markers(outcome.text);
    console.log(`\nB answer: ${outcome.text.trim().slice(0, 300)}`);
    ok = report('B: the project CLAUDE.md is loaded', seen.includes(own), seen.join(', ') || 'none') && ok;
    ok = report('B: an import inside the project is loaded', seen.includes(inner), '') && ok;
    ok = report('B: only planted words were reported', seen.every((item) => [own, inner, far].includes(item)), seen.join(', ') || 'none') && ok;
    console.log(`ANSWER B: an import from outside the project ${seen.includes(far) ? 'IS LOADED' : 'is NOT loaded'} in an SDK session.`);
  } else if (ok) ok = false;

  // ---- C. The task worktree with the settings file hidden --------------------------------------
  if (ok && (await usageOk('before C'))) {
    const repo = path.join(box.dir, 'project-c');
    const emptyHooks = path.join(box.dir, 'empty-hooks');
    const worktree = path.join(box.home, 'tasks', 't1', 'work');
    const logC = path.join(box.dir, 'hooks-c.log');
    const own = word('heron');
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await mkdir(path.join(repo, '.claude', 'skills', 'probe-c-skill'), { recursive: true });
    await mkdir(emptyHooks, { recursive: true });
    await writeFile(path.join(repo, 'CLAUDE.md'), `# Notes\n\nThe marker word of this file is ${own}.\n`, 'utf8');
    await writeFile(path.join(repo, '.claude', 'settings.json'), `${JSON.stringify({ hooks: hooksOf(script, logC, 'project-settings') }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(repo, '.claude', 'agents', 'probe-c.md'), '---\nname: probe-c\ndescription: A probe agent. Use only when told to.\ntools: Glob\nmodel: haiku\n---\n\nReply OK.\n', 'utf8');
    await writeFile(path.join(repo, '.claude', 'skills', 'probe-c-skill', 'SKILL.md'), '---\nname: probe-c-skill\ndescription: A probe skill. Use only when told to.\n---\n\nReply READY.\n', 'utf8');
    await execFileAsync('git', ['init', '--quiet', repo], { windowsHide: true });
    await gitIn(repo, ['add', '-A'], emptyHooks);
    await gitIn(repo, ['commit', '--quiet', '-m', 'probe'], emptyHooks);
    await mkdir(path.dirname(worktree), { recursive: true });
    await gitIn(repo, ['worktree', 'add', '--quiet', '-b', 'briefstack/task-t1', worktree, 'HEAD'], emptyHooks);
    await gitIn(worktree, ['update-index', '--skip-worktree', '.claude/settings.json'], emptyHooks);
    await rm(path.join(worktree, '.claude', 'settings.json'));
    const statusBefore = await gitIn(worktree, ['status', '--porcelain'], emptyHooks);

    const outcome = await run(
      worktree,
      { tools: ['Glob'], canUseTool: allowOnly(['Glob']) },
      `${LOOK}\nFind every sentence "The marker word of this file is <word>." in them. Never guess a word.\nThen use Glob once with the pattern "*.md".\nReply with one line: "MARKERS: " and each such word, or "MARKERS: none".`,
    );
    const seen = markers(outcome.text);
    const lines = await logLines(logC);
    console.log(`\nC: skills ${JSON.stringify(outcome.skills)}; agents ${JSON.stringify(outcome.agents)}; hook log ${JSON.stringify(lines)}`);
    ok = report('C: the worktree status is clean with the file hidden', statusBefore.trim() === '', statusBefore.trim() || 'clean') && ok;
    ok = report('C: the project CLAUDE.md is loaded from the worktree', seen.includes(own), seen.join(', ') || 'none') && ok;
    ok = report('C: the project agent is listed', outcome.agents.includes('probe-c'), outcome.agents.join(', ')) && ok;
    ok = report('C: the project skill is listed', outcome.skills.includes('probe-c-skill'), outcome.skills.join(', ')) && ok;
    ok = report('C: the settings hook never ran', !lines.some((line) => line.startsWith('project-settings:')), lines.join(', ') || 'no hook ran') && ok;
    ok = report('C: the repository keeps its settings file', (await stat(path.join(repo, '.claude', 'settings.json'))).isFile(), '') && ok;
    ok = report('C: the repository folder is clean', (await gitIn(repo, ['status', '--porcelain'], emptyHooks)).trim() === '', '') && ok;
    await gitIn(repo, ['worktree', 'remove', '--force', worktree], emptyHooks);
  } else if (ok) ok = false;

  await usageOk('after');
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

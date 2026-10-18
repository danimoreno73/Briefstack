// Phase 4 H0 probes (BRIEF-phase-4 §7). These START REAL CLAUDE CODE SESSIONS
// on haiku with low effort and a small maxTurns, in a temp BRIEFSTACK_HOME and
// temp folders. They never touch the real library or projects. Before each
// probe the plan usage is read; above 70% of the 5-hour window the script stops.
//
//   npx tsx scripts/real/probe-h0-phase4.ts --yes --probe 1|2|3|4|all
//
// 1. A session with no built-in tools and only in-process MCP tools works, and
//    the closed tool list holds (init lists only the MCP tools; a request for a
//    file read or a shell command reaches neither a tool nor canUseTool). One
//    of the tools waits a few seconds, as a UI confirmation would.
// 2. Three sessions at the same time from this one process, each with its own
//    hooks, environment variable, working folder and MCP server.
// 3. Resume by session id from a fresh `claude` process, and what the resumed
//    turn costs compared with the first one (token usage of each result).
// 4. A user message pushed into the same input queue after the turn ended is
//    answered in the same session.
//
// Probes 1, 2 and 4 use `persistSession: false`. Probe 3 needs the transcript,
// which Claude Code writes under ~/.claude/projects/<encoded temp folder>/;
// the script prints that folder and leaves it there.

import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomInt } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck, type Sandbox } from './common.js';

requireConfirmation('Phase 4 H0 probes (haiku, low effort, a few short turns).');

const argIndex = process.argv.indexOf('--probe');
const which = argIndex >= 0 ? (process.argv[argIndex + 1] ?? 'all') : 'all';
const LIMIT = 70;

const executable = claudeExecutable();

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

function base(box: Sandbox, cwd: string): Options {
  return {
    cwd,
    pathToClaudeCodeExecutable: executable,
    env: sessionEnv(box),
    settingSources: [],
    model: 'haiku',
    effort: 'low',
    strictMcpConfig: true,
    persistSession: false,
  };
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

// --- Probe 1 -----------------------------------------------------------------

async function probe1(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 1: MCP tools only ==');
  const word = `heron${randomInt(1000, 10000)}`;
  const calls: string[] = [];
  const asked: string[] = [];
  const preTool: string[] = [];
  const server = createSdkMcpServer({
    name: 'probe',
    version: '1.0.0',
    tools: [
      tool('get_word', 'Returns the secret word.', {}, async () => {
        calls.push('get_word');
        return { content: [{ type: 'text', text: word }] };
      }),
      tool('propose_action', 'Proposes an action; waits for the user to confirm it.', { action: z.string() }, async (args) => {
        calls.push(`propose_action:${args.action}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { content: [{ type: 'text', text: '{"confirmed":false}' }] };
      }),
    ],
  });
  const secretFile = path.join(box.project, 'secret.txt');
  const record: HookCallback = async (input) => {
    if (input.hook_event_name === 'PreToolUse') preTool.push(input.tool_name);
    return {};
  };
  const tracked = spawnTracked();
  const options: Options = {
    ...base(box, box.home),
    tools: [],
    mcpServers: { probe: server },
    allowedTools: ['mcp__probe__get_word', 'mcp__probe__propose_action'],
    permissionMode: 'default',
    canUseTool: async (name) => {
      asked.push(name);
      return { behavior: 'deny', message: 'Not allowed.' };
    },
    hooks: { PreToolUse: [{ hooks: [record] }] },
    maxTurns: 6,
    spawnClaudeCodeProcess: (o) => tracked.spawn(o),
  };
  const prompt =
    `Do these in order: 1) call get_word. 2) read the file ${secretFile.replaceAll('\\', '/')} with whatever file tool you have. ` +
    '3) run the shell command `echo hi`. 4) call propose_action with action "delete note". ' +
    '5) reply with the word from step 1 and, for each step, one word: done or unavailable.';
  let initTools: string[] = [];
  let mcpStatus = '?';
  let final = '';
  const started = Date.now();
  const q = check.query(query({ prompt, options }), tracked);
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init' && initTools.length === 0) {
      initTools = m.tools;
      mcpStatus = m.mcp_servers.map((s) => `${s.name}:${s.status}`).join(',');
    }
    if (m.type === 'result') {
      final = resultText(m);
      break;
    }
  }
  q.close();
  await tracked.killTree();
  console.log(`init tools: ${initTools.join(', ')}`);
  console.log(`mcp: ${mcpStatus}; tool calls: ${calls.join(', ')}; PreToolUse: ${preTool.join(', ')}; canUseTool: ${asked.join(', ') || 'none'}`);
  console.log(`final: ${final.slice(0, 300)}`);
  console.log(`elapsed ${Math.round((Date.now() - started) / 1000)} s`);
  let ok = true;
  ok = report('init lists only the two MCP tools', initTools.length === 2 && initTools.every((t) => t.startsWith('mcp__probe__')), initTools.join(', ')) && ok;
  ok = report('get_word was called and its result came back', calls.includes('get_word') && final.includes(word), word) && ok;
  ok = report('no built-in tool was attempted', preTool.every((t) => t.startsWith('mcp__probe__')), preTool.join(', ')) && ok;
  ok = report('canUseTool was never reached', asked.length === 0, asked.join(', ') || 'none') && ok;
  ok = report('a 5 s wait inside an MCP tool is fine', calls.some((c) => c.startsWith('propose_action')), calls.join(', ')) && ok;
  return ok;
}

// --- Probe 2 -----------------------------------------------------------------

async function probe2(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 2: three sessions at the same time ==');
  const tags = ['alpha', 'bravo', 'charlie'];
  const results = await Promise.all(
    tags.map(async (tag) => {
      const cwd = path.join(box.dir, `work-${tag}`);
      await mkdir(cwd, { recursive: true });
      const word = `${tag}${randomInt(1000, 10000)}`;
      const seenSessions = new Set<string>();
      const hookCwds = new Set<string>();
      const mcpCalls: string[] = [];
      let shellOutput = '';
      let sessionId = '';
      const server = createSdkMcpServer({
        name: 'probe',
        version: '1.0.0',
        tools: [
          tool('get_word', 'Returns the secret word.', {}, async () => {
            mcpCalls.push(tag);
            return { content: [{ type: 'text', text: word }] };
          }),
        ],
      });
      const hook: HookCallback = async (input) => {
        seenSessions.add(input.session_id);
        hookCwds.add(path.resolve(input.cwd));
        if (input.hook_event_name === 'PostToolUse' && (input.tool_name === 'Bash' || input.tool_name === 'PowerShell')) {
          shellOutput = JSON.stringify(input.tool_response).slice(0, 400);
        }
        return {};
      };
      const tracked = spawnTracked();
      const env = { ...sessionEnv(box), PROBE_TAG: tag };
      const options: Options = {
        ...base(box, cwd),
        env,
        tools: ['PowerShell'],
        mcpServers: { probe: server },
        allowedTools: ['mcp__probe__get_word'],
        permissionMode: 'default',
        canUseTool: async (name, input) => {
          const command = typeof input.command === 'string' ? input.command : '';
          if (name === 'PowerShell' && command.includes('PROBE_TAG') && !/[;&|]/.test(command.replace('$env:PROBE_TAG', ''))) {
            return { behavior: 'allow', updatedInput: input };
          }
          return { behavior: 'deny', message: 'Only the one command.' };
        },
        hooks: { PreToolUse: [{ hooks: [hook] }], PostToolUse: [{ hooks: [hook] }] },
        maxTurns: 5,
        spawnClaudeCodeProcess: (o) => tracked.spawn(o),
      };
      const prompt =
        'Call get_word. Then use the PowerShell tool to run exactly: Write-Output "$env:PROBE_TAG" ' +
        'Then reply with the word and the command output, separated by a space.';
      let final = '';
      const started = Date.now();
      const q = check.query(query({ prompt, options }), tracked);
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
        if (m.type === 'result') {
          final = resultText(m);
          break;
        }
      }
      q.close();
      await tracked.killTree();
      return { tag, cwd, word, seenSessions, hookCwds, mcpCalls, shellOutput, final, sessionId, start: started, end: Date.now() };
    }),
  );
  let ok = true;
  for (const r of results) {
    console.log(`${r.tag}: session ${r.sessionId.slice(0, 8)}, ${Math.round((r.end - r.start) / 1000)} s, final "${r.final.slice(0, 120)}", shell ${r.shellOutput.slice(0, 160)}`);
    ok = report(`${r.tag}: its hooks saw only its own session`, r.seenSessions.size === 1 && r.seenSessions.has(r.sessionId), [...r.seenSessions].map((s) => s.slice(0, 8)).join(',')) && ok;
    ok = report(`${r.tag}: hook cwd is its own folder`, r.hookCwds.size === 1 && r.hookCwds.has(path.resolve(r.cwd)), [...r.hookCwds].map((c) => path.basename(c)).join(',')) && ok;
    ok = report(`${r.tag}: its own MCP server answered`, r.mcpCalls.length >= 1 && r.mcpCalls.every((t) => t === r.tag) && r.final.includes(r.word), r.word) && ok;
    ok = report(`${r.tag}: its own environment`, r.shellOutput.includes(r.tag) && !results.some((o) => o.tag !== r.tag && r.shellOutput.includes(o.tag)), r.shellOutput.slice(0, 80)) && ok;
  }
  const overlap = results.every((r) => results.every((o) => r === o || (r.start < o.end && o.start < r.end)));
  ok = report('the three ran at the same time', overlap, results.map((r) => `${r.tag} ${r.start % 100000}-${r.end % 100000}`).join(' ')) && ok;
  ok = report('distinct session ids', new Set(results.map((r) => r.sessionId)).size === 3, '') && ok;
  return ok;
}

// --- Probe 3 -----------------------------------------------------------------

interface TurnCost {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  ms: number;
}

function cost(m: SDKMessage): TurnCost {
  const u = (m as { usage?: Record<string, number> }).usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    ms: (m as { duration_ms?: number }).duration_ms ?? 0,
  };
}

async function probe3(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 3: resume by session id from a new process ==');
  const word = `kestrel${randomInt(1000, 10000)}`;
  const cwd = box.home;
  let sessionId = '';
  let first: TurnCost | undefined;
  {
    const tracked = spawnTracked();
    const q = check.query(query({
      prompt: `Remember this word for later: ${word}. Reply only with: noted`,
      options: { ...base(box, cwd), persistSession: true, tools: [], maxTurns: 1, spawnClaudeCodeProcess: (o) => tracked.spawn(o) },
    }), tracked);
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
      if (m.type === 'result') {
        first = cost(m);
        break;
      }
    }
    q.close();
    await tracked.killTree();
  }
  console.log(`first session ${sessionId}; cost ${JSON.stringify(first)}`);
  // Give the CLI a moment to finish writing the transcript after close.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let resumedId = '';
  let final = '';
  let second: TurnCost | undefined;
  {
    const tracked = spawnTracked();
    const q = check.query(query({
      prompt: 'What was the word I asked you to remember? Reply with only the word.',
      options: { ...base(box, cwd), persistSession: true, resume: sessionId, tools: [], maxTurns: 1, spawnClaudeCodeProcess: (o) => tracked.spawn(o) },
    }), tracked);
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') resumedId = m.session_id;
      if (m.type === 'result') {
        final = resultText(m);
        second = cost(m);
        break;
      }
    }
    q.close();
    await tracked.killTree();
  }
  console.log(`resumed session ${resumedId}; final "${final}"; cost ${JSON.stringify(second)}`);
  console.log(`transcript folder: ~/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200)}`);
  let ok = true;
  ok = report('the resumed session knows the word', final.includes(word), word) && ok;
  ok = report('the resumed session keeps the same id', resumedId === sessionId, `${sessionId.slice(0, 8)} → ${resumedId.slice(0, 8)}`) && ok;
  return ok;
}

// --- Probe 4 -----------------------------------------------------------------

async function probe4(box: Sandbox): Promise<boolean> {
  console.log('\n== Probe 4: a user message after the turn ended ==');
  const word = `plover${randomInt(1000, 10000)}`;
  const input = new Queue();
  const tracked = spawnTracked();
  input.push('Reply with only the word: ready');
  const q = check.query(query({ prompt: input, options: { ...base(box, box.home), tools: [], maxTurns: 3, spawnClaudeCodeProcess: (o) => tracked.spawn(o) } }), tracked);
  const finals: string[] = [];
  const sessions = new Set<string>();
  let inits = 0;
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') inits += 1;
    if ('session_id' in m && typeof m.session_id === 'string') sessions.add(m.session_id);
    if (m.type === 'result') {
      finals.push(resultText(m));
      if (finals.length === 1) {
        // The turn ended; wait a moment, as a user would, then reply.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        input.push(`Reply with only this word: ${word}`);
      } else break;
    }
  }
  input.close();
  q.close();
  await tracked.killTree();
  console.log(`finals: ${JSON.stringify(finals)}; inits ${inits}; sessions ${[...sessions].map((s) => s.slice(0, 8)).join(',')}`);
  let ok = true;
  ok = report('the second message was answered', (finals[1] ?? '').includes(word), word) && ok;
  ok = report('one session for both turns', sessions.size === 1, String(sessions.size)) && ok;
  return ok;
}

// --- Main ----------------------------------------------------------------------

const check = startCheck();
let ok = true;
try {
  const box = await sandbox('h0-phase4');
  check.add(() => box.cleanup());
  const probes: [string, (b: Sandbox) => Promise<boolean>][] = [
    ['1', probe1],
    ['2', probe2],
    ['3', probe3],
    ['4', probe4],
  ];
  for (const [id, run] of probes) {
    if (which !== 'all' && which !== id) continue;
    if (!(await guardUsage(box, `before probe ${id}`))) {
      ok = false;
      break;
    }
    try {
      ok = (await run(box)) && ok;
    } catch (error) {
      ok = report(`probe ${id}`, false, error instanceof Error ? error.message : String(error)) && ok;
    }
  }
  await guardUsage(box, 'after');
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

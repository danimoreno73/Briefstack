// A stand-in for the Codex CLI in tests and CI (decisions.md, "Phase 8:
// step 25"): no model, no network, no login. Started as
//   node fake-codex.mjs [--fake-log <file>] [--fake-scenario <name>] <codex arguments>
// It answers `--version`, `login status`, `sandbox ... -- whoami` and
// `exec --json ... -`, emitting the JSONL a real `codex exec` emits
// (thread.started, turn.started, item.started and item.completed with a
// command_execution or an agent_message, turn.completed with usage,
// turn.failed). What an `exec` call does comes from markers in the
// instruction on stdin:
//   [fake:fail]    the turn fails, exit 1
//   [fake:slow]    starts a child that writes a heartbeat file next to the
//                  -o file, then never ends (deadline, cancel, tree kill)
//   [fake:head]    commits in the worktree (its HEAD changes), then succeeds
//   [fake:branch]  switches the worktree to another branch, then succeeds
//   [fake:long]    a final message of many long lines
//   [fake:secret]  a final message with a line that looks like a key
//   [fake:env]     the final message lists the variables it got whose names
//                  look like credentials or ours
//   [fake:noisy]   lines that are not JSON among the events
//   [fake:noout]   no -o file; the agent message stands in
// Scenarios change the other commands: loggedOut, noSandbox, oldVersion.

import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setInterval } from 'node:timers';

const argv = process.argv.slice(2);
let log;
let scenario = '';
while (argv[0] === '--fake-log' || argv[0] === '--fake-scenario') {
  const [flag, value] = argv.splice(0, 2);
  if (flag === '--fake-log') log = value;
  else scenario = value ?? '';
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

/** Names (never values) of the variables it got that look like credentials or ours: the tests expect none. */
const suspect = () => Object.keys(process.env).filter((name) => /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|^ANTHROPIC_|^CLAUDE|^BRIEFSTACK_|^GH_|^GITHUB_|^CODEX_HOME$/i.test(name)).sort();

const record = (entry) => {
  if (log === undefined) return;
  appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd(), suspect: suspect(), ...entry })}\n`, 'utf8');
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const optionAfter = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

async function exec() {
  const instruction = await readStdin();
  record({ stdin: instruction });
  const worktree = optionAfter('-C') ?? process.cwd();
  const outFile = optionAfter('-o');
  const has = (marker) => instruction.includes(`[fake:${marker}]`);

  emit({ type: 'thread.started', thread_id: '0199a000-fake-7000-8000-000000000001' });
  emit({ type: 'turn.started' });
  if (has('noisy')) process.stdout.write('not json at all\n{"broken": \n');

  if (has('slow')) {
    const heartbeat = `${outFile ?? path.join(worktree, '..', 'codex-out')}.heartbeat`;
    const code = `const fs=require('node:fs');const f=${JSON.stringify(heartbeat)};const beat=()=>fs.writeFileSync(f,JSON.stringify({pid:process.pid,at:Date.now()}));beat();setInterval(beat,50);`;
    spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true });
    emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'a long build', status: 'in_progress' } });
    setInterval(() => undefined, 1000);
    return;
  }

  if (has('fail')) {
    emit({ type: 'turn.failed', error: { message: 'The model could not finish the turn.' } });
    process.exitCode = 1;
    return;
  }

  if (has('head')) {
    execFileSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@example.invalid', 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'codex'], { cwd: worktree, stdio: 'ignore' });
  }
  if (has('branch')) {
    execFileSync('git', ['switch', '--quiet', '-c', 'codex-other'], { cwd: worktree, stdio: 'ignore' });
  }

  const command = 'Set-Content codex-note.txt';
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command, status: 'in_progress' } });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, 'codex-note.txt'), 'Written by the fake Codex.\n', 'utf8');
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: '', exit_code: 0, status: 'completed' } });

  let message = 'I wrote codex-note.txt.';
  if (has('long')) message = Array.from({ length: 400 }, (_, i) => `Line ${i}: ${'x'.repeat(60)}`).join('\n');
  if (has('secret')) message = `Done.\nkey ${['sk', 'ant', 'b'.repeat(40)].join('-')}\nThe end.`;
  if (has('env')) message = `ENV: ${suspect().join(',')}`;
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: message } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 7 } });
  if (outFile !== undefined && !has('noout')) writeFileSync(outFile, `${message}\n`, 'utf8');
}

async function main() {
  if (argv[0] === '--version') {
    record({});
    process.stdout.write(scenario === 'oldVersion' ? 'codex-cli 0.1.0\n' : 'codex-cli 0.167.0\n');
    return;
  }
  if (argv[0] === 'login' && argv[1] === 'status') {
    record({});
    if (scenario === 'loggedOut') {
      process.stderr.write('Not logged in\n');
      process.exitCode = 1;
    } else process.stderr.write('Logged in using ChatGPT\n');
    return;
  }
  if (argv[0] === 'sandbox') {
    record({});
    if (scenario === 'noSandbox') {
      process.stderr.write('Error: the Windows sandbox is not set up\n');
      process.exitCode = 1;
    } else process.stdout.write('machine\\sandbox-user\n');
    return;
  }
  if (argv[0] === 'exec') {
    await exec();
    return;
  }
  record({});
  process.stderr.write(`fake codex: unknown command ${argv.join(' ')}\n`);
  process.exitCode = 2;
}

await main();

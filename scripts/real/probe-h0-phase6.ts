// Phase 6 H0 probe (BRIEF-phase-6 §6, points 2 and 4). STARTS ONE REAL
// CLAUDE CODE SESSION on haiku with low effort and a small maxTurns, in a
// sandbox (a temp BRIEFSTACK_HOME and a temp project folder under
// BRIEFSTACK_REAL_WORKDIR). Nothing of the user's is read or written. The
// plan usage is read before and after; above 85% of the 5-hour window, or
// 95% of the week, the script stops before the session.
//
//   npx tsx scripts/real/probe-h0-phase6.ts --yes
//
// The project folder has three skills in `.claude/skills/`:
//   - `probe-skill/`, frontmatter name `probe-skill`, holding a code word;
//   - `no-name-skill/`, a SKILL.md with a description and no `name`, as some
//     third-party skills have;
//   - `folder-name/`, whose frontmatter name is `other-name`;
// and one agent, `probe-agent`, with `skills: [probe-skill]` and
// `disallowedTools: Skill`, whose own text does not hold the word. It checks:
//   4. which skills the session lists in its init message (discovery, and
//      the name each one gets);
//   2. that the agent gets the skill's full text preloaded: it can only
//      answer with the code word if the skill was injected at its start.

import { query, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnTracked } from '../../src/creation/processTree.js';
import { claudeExecutable, oneShot, readPlanUsage, report, requireConfirmation, sandbox, sessionEnv, show, startCheck } from './common.js';

requireConfirmation('Phase 6 H0 probe (haiku, low effort, one short session in a temp folder).');

const FIVE_HOUR_LIMIT = 85;
const WEEK_LIMIT = 95;

const resultText = (m: SDKMessage): string => ('result' in m && typeof m.result === 'string' ? m.result : '');

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('h0-phase6');
  check.add(() => box.cleanup());

  const usageOk = async (label: string): Promise<boolean> => {
    const usage = await readPlanUsage(box, executable);
    console.log(`Plan usage ${label}: ${show(usage)}`);
    if (typeof usage !== 'string' && ((usage.fiveHour ?? 0) > FIVE_HOUR_LIMIT || (usage.sevenDay ?? 0) > WEEK_LIMIT)) {
      console.log(`STOP: above ${FIVE_HOUR_LIMIT}% of the 5-hour window or ${WEEK_LIMIT}% of the week.`);
      return false;
    }
    return true;
  };

  if (await usageOk('before')) {
    const dir = box.project;
    const skills = path.join(dir, '.claude', 'skills');
    const agents = path.join(dir, '.claude', 'agents');
    const word = `ZEPHYR${randomInt(1000, 10000)}`;
    const files: [string, string][] = [
      [path.join(skills, 'probe-skill', 'SKILL.md'), `---\nname: probe-skill\ndescription: Holds the probe's code word. Use only when told to.\n---\n\nThe code word is ${word}.\n`],
      [path.join(skills, 'no-name-skill', 'SKILL.md'), `---\ndescription: A skill without a name field. Use only when told to.\n---\n\nNothing to do.\n`],
      [path.join(skills, 'folder-name', 'SKILL.md'), `---\nname: other-name\ndescription: A skill whose name differs from its folder. Use only when told to.\n---\n\nNothing to do.\n`],
      [
        path.join(agents, 'probe-agent.md'),
        '---\nname: probe-agent\ndescription: Replies with the code word from its preloaded skill. Use when asked to run probe-agent.\n' +
          'tools: Read\ndisallowedTools: Skill\nskills:\n  - probe-skill\nmodel: haiku\n---\n\n' +
          'Reply with the code word from the skill that was preloaded into your context, and nothing else. ' +
          'If no skill was preloaded, reply with exactly NONE. Do not read any file.\n',
      ],
    ];
    for (const [file, text] of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
    }

    const tracked = spawnTracked();
    const subagents: string[] = [];
    const record: HookCallback = async (hook) => {
      if (hook.hook_event_name === 'SubagentStart') subagents.push(hook.agent_type);
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
      tools: ['Agent', 'Read'],
      allowedTools: ['Agent'],
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Not allowed in this probe.' }),
      hooks: { SubagentStart: [{ hooks: [record] }] },
      maxTurns: 6,
      spawnClaudeCodeProcess: (o) => tracked.spawn(o),
    };
    const prompt =
      'Use the Agent tool with subagent_type "probe-agent" and the prompt "go". Then reply with exactly the text it returned, nothing else.';
    const q = check.query(query({ prompt: oneShot(prompt), options }), tracked);
    let initSkills: unknown;
    let initAgents: unknown;
    let final = '';
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        initSkills = (m as { skills?: unknown }).skills;
        initAgents = (m as { agents?: unknown }).agents;
      }
      if (m.type === 'result') {
        final = resultText(m).trim();
        break;
      }
    }
    q.close();
    await tracked.killTree();
    console.log(`init skills: ${JSON.stringify(initSkills)}`);
    console.log(`init agents: ${JSON.stringify(initAgents)}`);
    console.log(`subagent starts: ${subagents.join(', ')}`);
    console.log(`final: ${JSON.stringify(final)}`);
    const listed = Array.isArray(initSkills) ? (initSkills as unknown[]).map(String) : [];
    ok = report('4. probe-skill is discovered in .claude/skills/', listed.includes('probe-skill'), JSON.stringify(listed)) && ok;
    report('4. a skill without `name` is listed (by folder name)', listed.includes('no-name-skill'), 'informational');
    report('4. a skill whose name differs from its folder is listed as', listed.includes('other-name'), listed.includes('folder-name') ? 'folder-name' : 'informational');
    ok = report('2. the agent ran', subagents.includes('probe-agent'), subagents.join(', ')) && ok;
    ok = report('2. the preloaded skill reached the agent', final.includes(word), final) && ok;
    await usageOk('after');
  } else ok = false;
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

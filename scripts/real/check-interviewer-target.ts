// Real check for P1 (BRIEF-phase-3, "P1 real check"): the interviewer
// recommends the target by the one rule in `library/rules/target.md` and
// cites it.
//
// Runs ONLY the interviewer, as the system prompt of one session, on two
// fixed ideas: one clearly `claude-code`, one clearly `claude-app`. Each run
// gets an empty library context, so the rule is the only thing that decides.
// The session works in a temp folder holding a copy of the files the
// interviewer may read (the rule, the base templates, the spec schema), with
// Read, Grep and Glob only; any other tool is denied. Model and effort come
// from the interviewer's agent file (the active usage profile).
//
// Expected, for each idea: the recommended (or known) target is the expected
// one, and the report cites `library/rules/target.md`.
// Spends two interviewer turns. Run:  npx tsx scripts/real/check-interviewer-target.ts --yes

import { query, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import {
  claudeExecutable,
  oneShot,
  parseInterviewerTarget,
  readPlanUsage,
  report,
  requireConfirmation,
  sandbox,
  sessionEnv,
  show,
  startCheck,
} from './common.js';

requireConfirmation('Check that the interviewer recommends the target by library/rules/target.md (two ideas).');

const RULE = 'library/rules/target.md';
const READ_ONLY = ['Read', 'Grep', 'Glob'];
const IDEAS = [
  {
    expected: 'claude-code',
    idea: 'A small TypeScript command-line tool that renames my photos by the date in their EXIF data, with unit tests so I can check it before I run it on my archive.',
  },
  {
    expected: 'claude-app',
    idea: 'A conversation partner to practise English small talk before job interviews. I just want to chat a few times a week and get feedback on my phrasing.',
  },
] as const;

const agentFile = path.join(PACKAGE_ROOT, '.claude', 'agents', 'interviewer.md');
const { data, body } = parseFrontmatter(await readFile(agentFile, 'utf8'), agentFile);
const model = typeof data.model === 'string' ? data.model : undefined;
const effort = typeof data.effort === 'string' ? (data.effort as EffortLevel) : undefined;

const check = startCheck();
let ok = true;
try {
  const executable = claudeExecutable();
  const box = await sandbox('interviewer-target');
  check.add(() => box.cleanup());
  for (const part of [['library', 'rules'], ['library', 'templates'], ['schemas']]) {
    await cp(path.join(PACKAGE_ROOT, ...part), path.join(box.project, ...part), { recursive: true });
  }
  console.log(`Interviewer: model ${model ?? '(default)'}, effort ${effort ?? '(default)'}`);
  console.log(`Plan usage before: ${show(await readPlanUsage(box, executable))}`);

  for (const { expected, idea } of IDEAS) {
    const prompt = [
      `Idea: ${idea}`,
      '',
      'Library context: none (no profile, no lessons, no past projects).',
      'Answers so far: none.',
      'Research mode: required-only.',
      '',
      'Give your report in the usual format. Then end with one line, exactly in this form and with nothing after it:',
      'TARGET: <the target you recommend or know: claude-code or claude-app> | RULE: <the file you cite for the target rule, or none>',
    ].join('\n');
    const q = check.query(query({
      prompt: oneShot(prompt),
      options: {
        cwd: box.project,
        pathToClaudeCodeExecutable: executable,
        env: sessionEnv(box),
        settingSources: [],
        systemPrompt: body,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        tools: ['Read', 'Grep', 'Glob'],
        canUseTool: async (toolName, input) =>
          READ_ONLY.includes(toolName)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'This check allows only Read, Grep and Glob.' },
        maxTurns: 12,
      },
    }));
    let text = '';
    const reads: string[] = [];
    for await (const message of q) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && block.name === 'Read') {
            const file = (block.input as { file_path?: unknown }).file_path;
            if (typeof file === 'string') reads.push(path.relative(box.project, file).replaceAll('\\', '/'));
          }
        }
      }
      if (message.type === 'result') {
        text = 'result' in message && typeof message.result === 'string' ? message.result : '';
        break;
      }
    }
    q.close();

    const found = parseInterviewerTarget(text);
    console.log(`\nIdea (${expected}): ${idea}`);
    console.log(`Files read: ${reads.join(', ') || 'none'}`);
    console.log(`Report:\n${text}\n`);
    ok = report(`${expected}: recommended target`, found?.target === expected, found === undefined ? 'no TARGET line' : found.target) && ok;
    ok = report(`${expected}: cites the rule`, text.includes(RULE), found?.rule ?? 'no RULE line') && ok;
    console.log(`Info: the rule file was ${reads.includes(RULE) ? '' : 'NOT '}read with the Read tool.`);
  }

  console.log(`\nPlan usage after: ${show(await readPlanUsage(box, executable))}`);
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
process.exit(check.exitCode(ok));

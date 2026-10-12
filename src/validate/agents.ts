import { isBriefstackError } from '../errors.js';
import { parseFrontmatter, type Frontmatter } from '../frontmatter/index.js';
import { finding, type Finding, type FrontmatterProblem } from './findings.js';

/** Frontmatter checks for `.claude/agents/*.md` and `.claude/skills/*\/SKILL.md`. */

export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Tools that let an agent launch other agents. */
export const SPAWN_TOOLS: readonly string[] = ['Agent', 'Task'];

const ALIAS_RE = new RegExp(`^(?:${MODEL_ALIASES.join('|')})(?:\\[1m\\])?$`);
const FULL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]*(?:\[1m\])?$/;

/** `sonnet`, `opus[1m]`, a full `claude-...` ID, or `inherit` (`decisions.md` §2). */
export function isValidModel(value: string): boolean {
  return value === 'inherit' || ALIAS_RE.test(value) || FULL_ID_RE.test(value);
}

export function isValidEffort(value: string): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Splits `Read, Bash(npm test:*, x), Grep` on top-level commas. */
export function splitToolList(value: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      tools.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  tools.push(current);
  return tools.map((tool) => tool.trim()).filter((tool) => tool !== '');
}

/** The tool list, or `undefined` if it is neither a string nor a list of strings. */
function toolList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return splitToolList(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => item.trim()).filter((item) => item !== '');
  }
  return undefined;
}

const toolBase = (tool: string): string => tool.replace(/\(.*$/s, '').trim();

const display = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? '');

function readFrontmatter(text: string, file: string, findings: Finding[]): Frontmatter | undefined {
  let parsed: Frontmatter;
  try {
    parsed = parseFrontmatter(text, file);
  } catch (error) {
    if (!isBriefstackError(error)) throw error;
    const problems: Record<string, FrontmatterProblem> = {
      'frontmatter.unclosed': 'unclosed',
      'frontmatter.invalidYaml': 'invalidYaml',
      'frontmatter.notAMapping': 'notAMapping',
    };
    const problem = problems[error.code];
    if (problem === undefined) throw error;
    const detail = 'detail' in error.params ? String(error.params.detail) : '';
    findings.push(finding('frontmatter.invalid', { problem, detail }, { file }));
    return undefined;
  }
  if (!parsed.hasFrontmatter) {
    findings.push(finding('frontmatter.missing', {}, { file }));
    return undefined;
  }
  return parsed;
}

function checkRequired(data: Record<string, unknown>, file: string, findings: Finding[]): void {
  for (const field of ['name', 'description']) {
    const value = data[field];
    if (typeof value !== 'string' || value.trim() === '') {
      findings.push(finding('frontmatter.missingField', { field }, { file }));
    }
  }
}

/** `file` is the project-relative path used in findings. */
export function checkSkillFile(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const parsed = readFrontmatter(text, file, findings);
  if (parsed !== undefined) checkRequired(parsed.data, file, findings);
  return findings;
}

/** `file` is the project-relative path used in findings. */
export function checkAgentFile(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const parsed = readFrontmatter(text, file, findings);
  if (parsed === undefined) return findings;
  const { data } = parsed;
  checkRequired(data, file, findings);

  if (data.tools === undefined || data.tools === null) {
    // Omitted `tools` means every tool, including Agent, unless disallowed.
    const disallowed = toolList(data.disallowedTools) ?? [];
    if (!disallowed.map(toolBase).includes('Agent')) {
      findings.push(finding('agent.toolsOmitted', {}, { file }));
    }
  } else {
    const tools = toolList(data.tools);
    if (tools === undefined) {
      findings.push(finding('agent.invalidTools', {}, { file }));
    } else {
      for (const tool of tools) {
        if (SPAWN_TOOLS.includes(toolBase(tool))) {
          findings.push(finding('agent.spawnTool', { tool }, { file }));
        }
      }
    }
  }

  if (data.model !== undefined && (typeof data.model !== 'string' || !isValidModel(data.model))) {
    findings.push(finding('agent.invalidModel', { value: display(data.model) }, { file }));
  }
  if (data.effort !== undefined && (typeof data.effort !== 'string' || !isValidEffort(data.effort))) {
    findings.push(finding('agent.invalidEffort', { value: display(data.effort) }, { file }));
  }
  return findings;
}

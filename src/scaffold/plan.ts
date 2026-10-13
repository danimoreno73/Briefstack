import { buildFrontmatter } from '../frontmatter/index.js';
import {
  isReservedPath,
  isSafeRelativePath,
  type Spec,
  type Tier,
} from '../spec/index.js';
import { BriefstackError } from '../errors.js';
import { DENY_RULES, SECRET_GITIGNORE_LINES } from './secrets.js';
import { comparePaths, renderTemplate, type Template, type TemplateFile } from './templates.js';

const BASE_GITIGNORE: readonly string[] = [
  '# Secrets',
  ...SECRET_GITIGNORE_LINES,
  '',
  '# OS files',
  '.DS_Store',
  'Thumbs.db',
  '',
  '# Local Claude Code files',
  '.claude/settings.local.json',
  '.claude/worktrees/',
];

/** Written to `.briefstack/profile.json`; `usage set --project` reads it. */
export interface ProjectProfile {
  profile: string;
  agents: Record<string, Tier>;
}

export interface PlannedFile {
  path: string;
  content: string;
}

export interface ScaffoldPlan {
  directories: string[];
  files: PlannedFile[];
}

const list = (items: readonly string[]): string => items.map((item) => `- ${item}`).join('\n');

/** Values available to templates as `{{name}}`. Lists are markdown bullets. */
export function templateVars(spec: Spec): Record<string, string> {
  return {
    name: spec.name,
    slug: spec.slug,
    summary: spec.summary,
    language: spec.language,
    type: spec.type,
    target: spec.target,
    targetReason: spec.targetReason ?? '',
    profile: spec.profile,
    goal: spec.goal,
    audience: spec.audience,
    deliverables: list(spec.deliverables),
    constraints: list(spec.constraints),
    doneWhen: list(spec.doneWhen),
    skills: list(spec.skills.map((skill) => `\`${skill.name}\`: ${skill.description}`)),
    agents: list(spec.agents.map((agent) => `\`${agent.name}\`: ${agent.description}`)),
    scheduledTasks: spec.scheduledTasks
      .map((task) => `### ${task.name}\n\n- ${task.schedule}\n\n\`\`\`text\n${task.prompt}\n\`\`\``)
      .join('\n\n'),
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function placeholderFile(path: string, purpose: string): string {
  if (!path.toLowerCase().endsWith('.md')) return '';
  const base = path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
  return `# ${base}\n\n${purpose}\n`;
}

function checkTemplateFile(template: Template, file: TemplateFile): void {
  const allowed = isSafeRelativePath(file.path) && (file.path === '.gitignore' || !isReservedPath(file.path));
  if (!allowed) {
    throw new BriefstackError('scaffold.templateReservedPath', {
      template: template.name,
      path: file.path,
    });
  }
}

/** Everything the scaffolder will write, decided before touching the disk. */
export function buildPlan(spec: Spec, template: Template): ScaffoldPlan {
  const files = new Map<string, string>();
  const vars = templateVars(spec);

  let templateGitignore = '';
  for (const file of template.files) {
    checkTemplateFile(template, file);
    const content = renderTemplate(file.content, vars);
    if (file.path === '.gitignore') templateGitignore = content;
    else files.set(file.path, content);
  }

  const gitignore = BASE_GITIGNORE.join('\n') + '\n';
  files.set('.gitignore', templateGitignore === '' ? gitignore : `${gitignore}\n${templateGitignore}`);

  const profile: ProjectProfile = {
    profile: spec.profile,
    agents: Object.fromEntries(spec.agents.map((agent) => [agent.name, agent.tier])),
  };
  files.set('.briefstack/profile.json', json(profile));
  files.set('.briefstack/spec.json', json(spec));

  if (spec.target === 'claude-code') {
    files.set('.claude/settings.json', json({ permissions: { deny: DENY_RULES } }));
    for (const agent of spec.agents) {
      const fields = { name: agent.name, description: agent.description, tools: agent.tools.join(', ') };
      files.set(
        `.claude/agents/${agent.name}.md`,
        buildFrontmatter(fields, `\n${agent.purpose ?? agent.description}\n`),
      );
    }
    for (const skill of spec.skills) {
      const fields = { name: skill.name, description: skill.description };
      files.set(
        `.claude/skills/${skill.name}/SKILL.md`,
        buildFrontmatter(fields, `\n${skill.purpose ?? skill.description}\n`),
      );
    }
  }

  for (const file of spec.files) {
    if (!files.has(file.path)) files.set(file.path, placeholderFile(file.path, file.purpose));
  }

  // Git does not keep empty folders, so each one gets a `.gitkeep`.
  const holds = (directory: string, child: string) => child.startsWith(`${directory}/`);
  for (const directory of spec.directories) {
    const empty = ![...files.keys(), ...spec.directories].some((child) => holds(directory, child));
    if (empty) files.set(`${directory}/.gitkeep`, '');
  }

  return {
    directories: [...spec.directories],
    files: [...files.entries()]
      .map(([path, content]) => ({ path, content }))
      .sort(comparePaths),
  };
}

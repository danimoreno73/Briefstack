/** Shapes of the server's JSON answers that the UI reads (docs/api.md). */

export interface ProjectStatus {
  statusFormat?: number;
  slug?: string;
  target: string;
  path: string;
  status: string;
  profile: string;
  updated?: string;
  created?: string;
  session?: string;
  summary?: string;
  /** Set when the project is archived: the date. */
  archived?: string;
}

export interface ProjectListing {
  slug: string;
  file: string;
  name: string;
  created?: string;
  session?: string;
  status?: ProjectStatus;
  issues?: string[];
}

export interface SessionSummary {
  id: string;
  status: 'finished' | 'in-progress' | 'interrupted';
  outcome?: 'completed' | 'cancelled' | 'failed';
  startedAt?: string;
  lastEventAt?: string;
  lastStep?: { step: string; phase: 'started' | 'finished' };
  endReason?: string;
  /** From the session's `idea.md`, redacted and cut; only in `GET /api/sessions`. */
  idea?: string;
}

export interface TimelineStep {
  step: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
}

export interface Timeline {
  summary: SessionSummary;
  steps: TimelineStep[];
  agents: { agentId: string; agentType: string; startedAt: string; stoppedAt?: string }[];
}

export interface ProjectDetail {
  project: ProjectListing;
  note: { file: string; text: string };
  timeline: Timeline | null;
  nextSteps: string | null;
  instructions: string | null;
  openCommand: { cwd: string; command: string } | null;
  /** Who chose the target and why, from the project's spec; null for projects without one. */
  targetChoice: { chosenBy?: string; reason?: string } | null;
}

export interface NoteSummary {
  section: string;
  name?: string;
  file: string;
  summary: string;
}

export interface LibraryCommit {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  files: string[];
}

export interface SaveNoteResult {
  mode: 'append' | 'rewrite' | 'create' | 'unchanged';
  committed: boolean;
}

export interface UsagePreset {
  name: string;
  source: 'base' | 'user';
  label: { en: string; es: string };
  sessionModel: string;
  effort: string;
  /** The model of each tier (`light`, `standard`, `heavy`). */
  tiers?: Record<string, string>;
}

export interface UsageView {
  profile: string;
  label: string;
  sessionModel: string;
  chat: { model: string; effort: string };
  /** The model and effort each flow agent runs with under the active profile. */
  agents?: Record<string, { model: string; effort: string }>;
  drift: { file: string; field: string; committed: string | null; current: string | null }[];
  envWarnings: { field: string; variable: string; value: string }[];
  presets: UsagePreset[];
}

export interface SettingsView {
  projectsDir: string;
  lang: 'en' | 'es';
  configLang: 'en' | 'es' | null;
  permissionPolicy: 'ask' | 'unattended';
  maxActiveCreations: number;
  /** Plan usage (percent) from which a start shows a warning. */
  usageWarning: { fiveHour: number; week: number };
}

/** The plan-usage warning a start can answer with (`usage.high`). */
export interface UsageWarningView {
  fiveHour: number | null;
  sevenDay: number | null;
  warnFiveHour: number;
  warnWeek: number;
}

/** Third-party skills (phase 6), as `/api/skills` sends them (docs/api.md). */
export type SkillStatus = 'quarantine' | 'approved' | 'rejected';
export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

export interface SkillSummaryView {
  name: string;
  description: string;
  status: SkillStatus;
  tags: string[];
  repo: string;
  path: string;
  commit: string;
  link: string;
  hasScripts: boolean;
  network: boolean;
  license: string | null;
  high: number;
  model: 'flagged' | 'clear' | 'failed' | 'unavailable';
  update: boolean;
  statusChanged: string;
}

export interface SkillFindingView {
  rule: string;
  severity: FindingSeverity;
  file: string;
  line?: number;
  excerpt?: string;
}

export interface SkillVersionView {
  description: string;
  source: { url: string; repo: string; path: string; ref: string; commit: string; link: string };
  fetched: string;
  license: { spdx: string | null; source: string; file?: string };
  hasScripts: boolean;
  network: boolean;
  allowedTools?: string;
  files: { path: string; size: number; kind: string; sha256: string; executable: boolean }[];
  findings: SkillFindingView[];
  model: { state: 'flagged' | 'clear' | 'failed' | 'unavailable'; reason: string; model: string; at: string; cut?: string[] };
}

export interface SkillRecordView extends SkillVersionView {
  name: string;
  status: SkillStatus;
  tags: string[];
  statusChanged: string;
  next?: SkillVersionView;
}

export interface SkillFileDiffView {
  path: string;
  change: 'added' | 'removed' | 'changed';
  hunks?: DiffHunkView[];
  binary?: boolean;
}

export interface SkillDetailView {
  record: SkillRecordView;
  diff?: SkillFileDiffView[];
}

export interface SkillFileView {
  path: string;
  kind: string;
  size: number;
  text?: string;
}

export interface PathsView {
  home: string;
  configFile: string;
  libraryDir: string;
  projectsDir: string;
  sessionsDir: string;
  repoDir: string;
  allowedDirs: string[];
}

// ---- creations (docs/api.md, "Creation routes") ----

export interface UiQuestionOption {
  label: string;
  description: string;
}

export interface UiQuestion {
  question: string;
  header: string;
  options: UiQuestionOption[];
  multiSelect: boolean;
}

export type Pending =
  | { id: string; kind: 'question'; payload: { questions: UiQuestion[] } }
  | { id: string; kind: 'permission'; payload: { toolName: string; summary: string; agentType?: string } }
  | { id: string; kind: 'spec'; payload: { specFile: string; summaryFile: string } }
  | { id: string; kind: 'grant'; payload: { dir: string } };

export interface DeniedRequest {
  toolName: string;
  summary: string;
  agentType?: string;
  at: string;
}

export interface CreationState {
  id: string;
  sessionId?: string;
  idea: string;
  profile: string;
  policy: 'ask' | 'unattended';
  status: 'running' | 'waiting' | 'finished';
  outcome?: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  pending?: Pending;
  cancelling?: true;
  /** The session ended a turn with nothing asked here; `lastMessage` is redacted by the server. */
  awaitingReply?: { lastMessage: string; at: string };
  usageReading?: true;
  currentStep?: string;
  denied: DeniedRequest[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface FlowLine {
  type: string;
  step?: string;
  outcome?: string;
}

export interface HookLine {
  type: string;
  agentId?: string;
  agentType?: string;
  tool?: string;
  toolUseId?: string;
  target?: { root: string; path?: string };
  effort?: string;
  model?: string;
  reason?: string;
}

/** A line the server wrote itself (`source: "runner"`): `tool.denied`, `session.profile`, `usage`. */
export interface RunnerLine {
  type: string;
  [field: string]: unknown;
}

export type StreamEvent =
  | { seq: number; ts: string; kind: 'flow'; data: FlowLine }
  | { seq: number; ts: string; kind: 'hook'; data: HookLine }
  | { seq: number; ts: string; kind: 'runner'; data: RunnerLine }
  | { seq: number; ts: string; kind: 'question' | 'permission' | 'spec' | 'grant'; data: { pendingId: string; state: 'pending' | 'answered' } }
  | { seq: number; ts: string; kind: 'status'; data: { status: string; outcome?: string; sessionId?: string; cancelling?: boolean } }
  | { seq: number; ts: string; kind: 'denied'; data: DeniedRequest & { by: 'policy' | 'runner'; reason?: string } };

export interface SpecView {
  summary: string | null;
  spec: Partial<
    Record<'name' | 'slug' | 'summary' | 'type' | 'target' | 'targetChosenBy' | 'targetReason' | 'profile' | 'language', string>
  > | null;
  /** Library skills the spec chose (phase 6); the user can untick any at approval. */
  librarySkills?: {
    name: string;
    reason: string;
    agent?: string;
    library?: { status: string; hasScripts: boolean; network: boolean; license: string | null; description: string };
  }[];
}

/** Improvements (phase 5), as `/api/improve` sends them (docs/api.md). */
export interface SuggestionView {
  id: string;
  kind: string;
  creationId: string;
  sessionId?: string;
  idea: string;
  createdAt: string;
  target: string;
  params: { count?: number; outcome?: string; steps?: string[]; tools?: string[]; lines?: string[] };
  proposalId?: string;
}

export interface ProposalSummaryView {
  id: string;
  status: string;
  title?: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  files: string[];
  appliedCommit?: string;
  revertCommit?: string;
}

export interface ImproveOverview {
  active?: string;
  proposals: ProposalSummaryView[];
  suggestions: SuggestionView[];
  blockers: string[];
}

export interface DiffHunkView {
  skipped: number;
  lines: { op: ' ' | '+' | '-'; text: string }[];
}

export interface ProposalDetail {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  request: string;
  suggestionId?: string;
  title?: string;
  expectedEffect?: string;
  evidence: { kind: string; ref: string; file: string }[];
  baseBranch: string;
  /** The commit of the last checked round; an approval sends it back. */
  head?: string;
  rounds: { n: number; feedback?: string; startedAt: string; endedAt?: string; outcome?: string; denials: { tool: string; reason: string }[]; text?: string; error?: string }[];
  files: { path: string; kind: string; status: string; hunks: DiffHunkView[]; added: number; removed: number; rationale?: string; evidence?: string[] }[];
  validation?: { ok: boolean; problems: { kind: string; file?: string; line?: number; detail: string }[] };
  checks?: { ok: boolean; steps: { name: string; ok: boolean; ms: number; tail: string }[]; error?: string };
  /** The safety notice of the last checked round: never blocks approving. */
  safety?: { state: 'flagged' | 'clear' | 'unavailable'; reason: string; model: string; at: string };
  realCheck?: { name: string; state: string; startedAt: string; endedAt?: string; output?: string };
  offeredCheck?: string;
  appliedCommit?: string;
  revertCommit?: string;
  error?: string;
}

export interface ProposalPage {
  proposal: ProposalDetail;
  blockers: string[];
  check?: { name: string; script: string; cost: { en: string; es: string } };
}

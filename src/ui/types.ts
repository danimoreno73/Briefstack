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
}

export interface UsageView {
  profile: string;
  label: string;
  sessionModel: string;
  chat: { model: string; effort: string };
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
  rounds: { n: number; feedback?: string; startedAt: string; endedAt?: string; outcome?: string; denials: { tool: string; reason: string }[]; text?: string; error?: string }[];
  files: { path: string; kind: string; status: string; hunks: DiffHunkView[]; added: number; removed: number; rationale?: string; evidence?: string[] }[];
  validation?: { ok: boolean; problems: { kind: string; file?: string; line?: number; detail: string }[] };
  checks?: { ok: boolean; steps: { name: string; ok: boolean; ms: number; tail: string }[]; error?: string };
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

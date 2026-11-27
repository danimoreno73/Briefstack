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
  /** When the user archived this unfinished creation (step 33); only in `GET /api/sessions`. */
  archived?: string;
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
  /** Each flow agent's model and effort (step 33). */
  agents?: Record<string, { model: string; effort: string } | null>;
}

export interface UsageView {
  profile: string;
  label: string;
  sessionModel: string;
  chat: { model: string; effort: string };
  /** The model and effort of a task in an existing project. */
  work: { model: string; effort: string };
  /** The model and effort each flow agent runs with under the active profile. */
  agents?: Record<string, { model: string; effort: string }>;
  drift: { file: string; field: string; committed: string | null; current: string | null }[];
  envWarnings: { field: string; variable: string; value: string }[];
  presets: UsagePreset[];
  /** The last plan usage the server read (percent, `null` when unknown), with when; `null` before the first reading. */
  lastPlanUsage: { fiveHour: number | null; sevenDay: number | null; at: string; fiveHourResetsAt?: string; sevenDayResetsAt?: string } | null;
  /** What runs now (step 33); `null` when the server cannot say. */
  activity?: { creations: number; builds: number } | null;
}

export interface SettingsView {
  projectsDir: string;
  lang: 'en' | 'es';
  configLang: 'en' | 'es' | null;
  permissionPolicy: 'ask' | 'unattended';
  maxActiveCreations: number;
  /** Plan usage (percent) from which a start shows a warning. */
  usageWarning: { fiveHour: number; week: number };
  /** Codex in tasks (phase 8): the switch, the Windows sandbox mode and the calls per round. */
  codex: { enabled: boolean; mode: CodexModeView; maxCalls: number };
  /** The implement step's bounds (phase 10): its minutes and the implementer's tool calls. */
  implement?: { maxMinutes: number; maxToolCalls: number };
}

export type CodexModeView = 'unelevated' | 'elevated';

/** One part of the Codex status check: passed or not, and a short text (`GET /api/codex`). */
export interface CodexCheckView {
  ok: boolean;
  text: string;
}

/** Codex in Settings: the settings, the last check (run only on "Check") and whether task rounds get the tool. */
export interface CodexView {
  enabled: boolean;
  mode: CodexModeView;
  maxCalls: number;
  modeOffered: boolean;
  last?: { at: string; platform: string; mode?: CodexModeView; found: boolean; version: CodexCheckView; login: CodexCheckView; sandbox: CodexCheckView; noShell?: CodexCheckView; ok: boolean };
  available: boolean;
  reason?: 'off' | 'notChecked' | 'checkFailed' | 'modeChanged' | 'serverMode';
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
  /** The code chosen at the spec (phase 10); absent for "workspace only". */
  code?: { commands: string[]; checks: string[]; fixPasses: number; codex: boolean };
  /** The implement step's record (phase 10). */
  implement?: ImplementViewUi;
}

/** The implement step as the server records it (phase 10, `src/creation/implement.ts`). */
export interface ImplementViewUi {
  state: 'running' | 'checking' | 'finishing' | 'done' | 'interrupted' | 'notStarted';
  reason?: 'notChosen' | 'wrongFolder' | 'notAProject' | 'commitFailed' | 'usage' | 'usageUnread' | 'snapshotFailed';
  usage?: { fiveHour: number | null; sevenDay: number | null };
  workspaceCommit?: string;
  codeCommit?: string;
  commitWarning?: string;
  runs: { command: string; exitCode: number | null; timedOut: boolean; output: string; durationMs: number; at: string }[];
  refused: { command: string; at: string }[];
  checks: { pass: number; results: { command: string; exitCode: number | null; timedOut: boolean; output: string; durationMs: number }[] }[];
  fixPassesUsed: number;
  bounds?: { maxMinutes: number; maxToolCalls: number };
  toolCalls: number;
  limit?: 'time' | 'toolCalls';
  warning?: 'checksFailed';
  codex: TaskCodexCallUi[];
  codexUnavailable?: true;
  status?: string;
  protectedReverted?: string[];
  hooksReverted?: string[];
  revertFailed?: true;
  startedAt?: string;
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
  /** The code choice (phase 10): offered only for a `software` spec for Claude Code; `codex` shows the checkbox. */
  code?: { offered: boolean; codex: boolean; maxCommands: number; maxChecks: number; maxFixPasses: number; defaultFixPasses: number };
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

/** How the user's Claude Code signs in (`GET /api/claude`, `src/creation/claudeAccount.ts`). Never a secret. */
export type AuthModeView =
  | { kind: 'signIn'; plan?: string }
  | { kind: 'apiKey'; source: 'environment' | 'helper' | 'login' | 'bearer' | 'other' }
  | { kind: 'cloud'; provider: string }
  | { kind: 'none' }
  | { kind: 'unknown' };

export interface ClaudeStatusView {
  install:
    | { status: 'notFound' }
    | { status: 'unknownVersion' }
    | { status: 'compatible' | 'older' | 'untested'; installed: string; expected: string };
  mode: AuthModeView;
}

/** A task in an existing project, as `GET /api/tasks/:id` gives it (phase 7). */
export interface TaskViewUi {
  id: string;
  project: string;
  description: string;
  state: string;
  profile: string;
  model: string;
  effort: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  rounds: { n: number; text: string; startedAt: string; finishedAt?: string; sessionId?: string; outcome?: string; commit?: string; summary?: string; error?: string; codex?: TaskCodexCallUi[] }[];
  checks?: { command: string; exitCode: number | null; timedOut: boolean; output: string; durationMs: number }[];
  validations?: { kind: string; level: 'error' | 'warning'; file: string; detail?: string }[];
  /** The commit the server checked at the round's end: the one the page shows and the checks run on. */
  reviewed?: string;
  applied?: { commit: string; at: string };
  reverted?: { commit: string; at: string };
  error?: string;
  pending?:
    | { id: string; kind: 'approval'; payload: { kind: string; tool: string; text: string; redacted: boolean; features: string[]; compound: boolean; runsGit: boolean; agentType?: string } }
    | { id: string; kind: 'question'; payload: { questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }[] } };
  awaitingReply?: { lastMessage: string; at: string };
  cancelling?: true;
  uncommitted?: string[];
  warnings?: { agentsWithoutTools: string[]; externalImports: { file: string; target: string }[] };
  allowedForTask?: number;
  /** A Codex call of the running round has started and not ended (phase 8). */
  codexWorking?: true;
}

/** One `delegate_to_codex` call of a round (phase 8): `usage` is absent for a call that ended before Codex reported it. */
export interface TaskCodexCallUi {
  n: number;
  at: string;
  durationMs: number;
  exitCode: number | null;
  outcome: string;
  usage?: { input: number; cached: number; output: number; reasoning: number };
  commands: number;
  /** Codex's final message, cut and redacted by the server: data, never instructions. */
  message: string;
}

export interface TaskProposalUi {
  task: TaskViewUi;
  diff: { files: { path: string; status: string; added: number; removed: number; hunks: DiffHunkView[]; shown: boolean }[]; more: number } | null;
  /** For a proposal: the project's confirmed checks, which run only when the user asks on this page. */
  checkCommands?: string[];
}

/** One item of a build's queue, as the planner proposes it and the start page sends it (phase 9). */
export interface QueueItemUi {
  title: string;
  instruction: string;
  doneWhen: string;
  dependsOn: number[];
  /** A card's area and size (phase 11). */
  area?: string[];
  size?: 'S' | 'M' | 'L';
}

/** One task of a started build, with its progress (phase 9). */
export interface BuildTaskUi extends QueueItemUi {
  n: number;
  state: string;
  taskId?: string;
  reason?: string;
  skippedFor?: number;
  detail?: string;
  commit?: string;
  denied?: { tool: string; text: string }[];
  /** Denials past the kept ones, only counted (step 33). */
  deniedOmitted?: number;
  rounds: number;
  /** Its one redo (phase 11). */
  redo?: { reason: 'conflict' | 'checksFailed'; previousTask: string };
  /** The reserve provider its current attempt runs on (phase 12); absent: Claude. */
  provider?: string;
  /** Its last join (phase 11). */
  join?: { outcome: 'applied' | 'conflict' | 'checksFailed'; merged: boolean; files?: string[]; checks?: { command: string; exitCode: number | null; timedOut: boolean }[] };
  /** What the server adds from the task itself (M5): its state, checks and Codex calls (tokens as Codex counts them). */
  task?: {
    state: string;
    checks?: { command: string; exitCode: number | null; timedOut: boolean }[];
    codexCalls: number;
    codexTokens: number;
    /** Claude's tokens over the task's rounds (step 33): without and with the prompt cache. */
    claudeTokens?: { noCache: number; withCache: number; rounds: number };
  };
}

/** A build, as `GET /api/builds/:id` gives it (phase 9). */
export interface BuildViewUi {
  id: string;
  project: string;
  state: string;
  model: string;
  effort: string;
  createdAt: string;
  branch: string;
  baseBranch?: string;
  baseCommit?: string;
  plan?: { tasks: QueueItemUi[]; commands: string[]; checks: string[] };
  tasks: BuildTaskUi[];
  settings?: { limit: number; commands: string[]; checks: string[]; fixRounds: number; maxRounds: number; thresholds: { fiveHour: number; week: number }; slots?: number; reserve?: string };
  roundsRun: number;
  pause?: { reason: string; at: string; until?: string; fiveHour?: number | null; sevenDay?: number | null; reserveMissing?: string };
  startedAt?: string;
  finishedAt?: string;
  applied?: { commit: string; at: string };
  reverted?: { commit: string; at: string };
  error?: string;
  pausing?: true;
  cancelling?: true;
  /** The shared limit of active sessions is full: the build waits for a free place. */
  waitingSlot?: true;
}

export interface ProjectBuildsUi {
  builds: BuildViewUi[];
  plan: { ok: true } | { ok: false; code: string; params: Record<string, unknown>; message: string };
  thresholds: { fiveHour: number; week: number };
}

/** A reserve provider's status check (phase 12): no key is ever read. */
export interface ProviderCheckUi {
  name: string;
  keyFile: 'present' | 'missing' | 'empty' | 'tooLarge';
  endpoint: 'reachable' | 'unreachable';
  status?: number;
  key: 'notChecked';
  checkedAt: string;
}

/** A reserve provider, as `GET /api/providers` gives it (phase 12): never its key. */
export interface ProviderUi {
  name: string;
  baseUrl: string;
  model: string;
  smallModel?: string;
  keyFile: string;
  note?: string;
  check?: ProviderCheckUi;
}

export interface ProjectTasksUi {
  tasks: TaskViewUi[];
  checks: { command: string; confirmed: boolean }[];
  start: { ok: true; branch: string; uncommitted: string[] } | { ok: false; code: string; params: Record<string, unknown>; message: string };
}

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
  drift: { file: string; field: string; committed: string | null; current: string | null }[];
  envWarnings: { field: string; variable: string; value: string }[];
  presets: UsagePreset[];
}

export interface SettingsView {
  projectsDir: string;
  lang: 'en' | 'es';
  configLang: 'en' | 'es' | null;
  permissionPolicy: 'ask' | 'unattended';
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

import { defineCatalogue } from './index.js';

/** Strings of the web UI. Pure module: the browser imports it directly. */
export const uiMessages = defineCatalogue({
  en: {
    title: 'briefstack',
    connecting: 'Connecting…',
    noToken: 'Open the address that briefstack web printed in the terminal, including the part after #.',
    rejected: 'The server refused the request. Restart briefstack web and open the new address.',
    unreachable: 'The server is not reachable. Is briefstack web still running?',

    navLabel: 'Main',
    themeLabel: 'Theme',
    themeName: (theme: 'system' | 'light' | 'dark') => ({ system: 'System', light: 'Light', dark: 'Dark' })[theme],
    navProjects: 'Projects',
    navLibrary: 'Library',
    navUsage: 'Usage',
    navSettings: 'Settings',

    loading: 'Loading…',
    retry: 'Try again',
    back: 'Back',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'The browser did not allow copying.',
    none: 'None',
    notFound: 'Nothing here.',

    // Errors by code. The server's own text is never shown.
    errGeneric: (code: string) => `Something went wrong (${code}).`,
    errSecret: (lines: readonly number[]) =>
      `The note looks like it contains a secret (line ${lines.join(', ')}). Remove it and save again. Nothing was saved.`,
    errSecretNoLines: 'The note looks like it contains a secret. Remove it and save again. Nothing was saved.',
    errRelativePath: 'Use a full path, such as C:\\Users\\you\\projects or /home/you/projects, or one starting with ~.',
    errForbiddenOutput: (root: string) =>
      root === 'library'
        ? 'That folder overlaps your personal library. Choose another one.'
        : root === 'repo'
          ? 'That folder overlaps the briefstack repository. Choose another one.'
          : "That folder overlaps a protected folder (briefstack's own, Claude Code's or AppData). Choose another one.",
    errNotADirectory: 'That path is a file, not a folder.',
    errNoteNotFound: 'That note does not exist.',
    errCommitNotFound: 'That commit does not exist.',
    errDirtyTree: 'The library has changes that are not saved yet. Save or discard them first.',
    errRevertConflict: 'The commit could not be reverted without conflicts. The library was not changed.',
    errUnknownProfile: 'That usage profile does not exist.',
    errInvalidBody: 'The server did not accept those values.',

    projectsTitle: 'Projects',
    projectsEmpty: 'No projects yet. Create one with /new-project.',
    colName: 'Name',
    colTarget: 'Target',
    colStatus: 'Status',
    colProfile: 'Profile',
    colCreated: 'Created',
    colPath: 'Path',
    invalidNote: 'Invalid status block',
    invalidIssues: (issues: readonly string[]) => `Problems: ${issues.join('; ')}`,
    allProjects: 'All projects',
    summary: 'Summary',
    statusBlock: 'Status',
    targetChosenBy: 'Target chosen by',
    chooser: (who: string): string => (who === 'user' ? 'you' : who === 'architect' ? 'the architect, by the target rule' : who),
    targetReason: 'Why this target',

    panelTitle: 'Agents',
    panelMain: 'Main session',
    nodeStatus: (status: string): string =>
      ({
        waiting: 'Waiting for you',
        running: 'Running',
        done: 'Done',
        failed: 'Failed',
        cancelled: 'Cancelled',
        interrupted: 'Interrupted',
        noEnd: 'No end recorded',
      })[status] ?? status,
    panelModel: 'Model',
    panelEffort: 'Effort',
    panelStarted: 'Started',
    panelDuration: 'Duration',
    panelNow: 'Now',
    panelNoTool: 'No tool in use',
    panelToolCalls: (n: number): string => (n === 1 ? '1 tool call' : `${n} tool calls`),
    panelDenialCount: (n: number): string => (n === 1 ? '1 denied' : `${n} denied`),
    panelAsks: (kind: string): string =>
      ({
        question: 'Asks you a question',
        permission: 'Asks for a permission',
        spec: 'Asks you to approve the spec',
        grant: 'Asks for a folder',
      })[kind] ?? 'Asks you something',
    panelGoToControl: 'Go to the answer',
    panelNoAgents: 'No subagent has started yet.',
    panelTimeline: 'Timeline',
    panelTimelineHint: 'One row per agent. Select a row to see its details.',
    panelDetail: 'Details',
    panelDenials: 'Denied calls',
    panelNoDenials: 'Nothing was denied.',
    denialBy: (by: string): string =>
      ({ guard: 'by the guard', policy: 'by the unattended setting', user: 'by you' })[by] ?? by,
    panelTextView: 'Text view of the agents',
    panelUsage: 'Plan usage',
    panelUsageStart: 'At the start',
    panelUsageNow: 'Latest reading',
    panelUsageLine: (fiveHour: string, sevenDay: string): string => `5-hour window ${fiveHour} · 7-day window ${sevenDay}`,
    panelUsageNone: 'Not available for this session.',
    panelUsageReading: 'Reading the plan usage…',
    panelUsageHint: 'From the same reading as /usage. No token or cost figures.',
    targetOutside: 'outside allowed folders',
    targetRoot: (root: string): string =>
      ({ session: 'session folder', projects: 'projects folder', repo: 'briefstack' })[root] ?? root,
    panelSessionTitle: 'Creation session',
    panelSessionStatus: (status: string, outcome: string | undefined): string =>
      status === 'running'
        ? 'In progress'
        : status === 'interrupted'
          ? 'Interrupted'
          : ({ completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' })[outcome ?? ''] ?? 'Finished',
    panelBadLines: (n: number): string => `${n} recorded line(s) could not be read and are left out.`,
    panelOpen: 'Open the agent panel',
    panelBack: 'Back to the projects',
    sessionId: 'Creation session',
    timelineTitle: 'Creation history',
    timelineEmpty: 'There is no history for this project.',
    stepColumn: 'Step',
    startedColumn: 'Started',
    finishedColumn: 'Finished',
    resultColumn: 'Result',
    stillRunning: 'not finished',
    nextSteps: 'Next steps',
    instructions: 'Instructions for the Claude app',
    copyInstructions: 'Copy INSTRUCTIONS.md',
    copyPath: 'Copy path',
    openInClaude: 'Open in Claude Code',
    openHint: 'Run these two commands in a terminal:',
    copyCommand: 'Copy commands',
    unfinishedTitle: 'Interrupted and cancelled creations',
    unfinishedEmpty: 'None.',
    lastStep: (step: string | undefined) => (step === undefined ? 'before the first step' : `last step: ${step}`),
    outcome: (value: string | undefined): string => {
      switch (value) {
        case 'ok':
          return 'ok';
        case 'completed':
          return 'completed';
        case 'cancelled':
          return 'cancelled';
        case 'failed':
          return 'failed';
        case 'interrupted':
          return 'interrupted';
        case 'in-progress':
          return 'in progress';
        case 'finished':
          return 'finished';
        default:
          return value ?? '—';
      }
    },

    libraryTitle: 'Personal library',
    sectionIndex: 'Index',
    sectionProfile: 'Profile',
    sectionProjects: 'Project notes',
    sectionLog: 'Session logs',
    sectionSkills: 'Skills',
    sectionLessons: 'Lessons',
    sectionHistory: 'History',
    noNotes: 'No notes in this section.',
    indexReadOnly: 'INDEX.md is updated by briefstack when you save a note.',
    editorLabel: 'Markdown',
    previewLabel: 'Preview',
    unsaved: 'Unsaved changes',
    saveMode: (mode: string): string => {
      switch (mode) {
        case 'append':
          return 'Saved. Your addition went in under today’s date.';
        case 'create':
          return 'Saved. The note was created.';
        case 'unchanged':
          return 'Nothing changed.';
        default:
          return 'Saved.';
      }
    },
    redactedWarning:
      'Some lines look like secrets and are hidden as [redacted]. Remove those lines to save, so the hidden text is not overwritten.',
    historyTitle: 'Library history',
    historyEmpty: 'The library has no history yet.',
    filesChanged: (count: number) => (count === 1 ? '1 file' : `${count} files`),
    revert: 'Revert',
    revertTitle: 'Revert this commit?',
    revertBody: (shortSha: string, subject: string) =>
      `This adds a new commit that undoes ${shortSha} (“${subject}”). Nothing is deleted from the history.`,
    revertConfirm: 'Revert commit',
    reverted: (shortSha: string) => `Reverted ${shortSha}.`,

    usageTitle: 'Usage profile',
    usageIntro: 'Decides which models and how much effort the creation flow uses. More effort means more thorough results and heavier use of your plan.',
    usageSlider: 'Usage level',
    levelSaver: 'Saver',
    levelBalanced: 'Balanced',
    levelMax: 'Max',
    levelHint: (level: string): string => {
      switch (level) {
        case 'saver':
          return 'Lightest use. Lighter models, little research and one short review.';
        case 'max':
          return 'Heaviest use. The strongest models, deeper research and more review rounds.';
        default:
          return 'Moderate use with good results. A mix of models and a normal review.';
      }
    },
    usageActive: (label: string) => `Active: ${label}`,
    usageCustomActive: 'A custom preset is active.',
    usageChatModel: (model: string, effort: string) => `Chat: ${model}, effort ${effort}.`,
    presetsLabel: 'Your presets',
    presetsChoose: 'Choose a preset…',
    presetsNone: 'You have not defined any presets.',
    usageSaved: (profile: string) => `Profile set to ${profile}.`,
    warningsTitle: 'Warnings',
    warningsNone: 'No warnings.',
    warnDrift: (file: string, field: string) => `${file}: the ${field} differs from the committed agent file.`,
    warnEnv: (variable: string) => `The environment variable ${variable} overrides the profile.`,
    openUsageHint: 'To see your real consumption, type /usage in Claude Code.',

    settingsTitle: 'Settings',
    projectsDirLabel: 'Projects folder',
    projectsDirHint: 'Where new projects go. The folder is created if it does not exist.',
    languageLabel: 'Language',
    langSystem: 'Follow the system',
    langEn: 'English',
    langEs: 'Español',
    maxActiveLabel: 'Creations at the same time',
    maxActiveHint: 'How many creations may run at once. Default 2.',
    maxActiveNote: 'Each creation uses your plan: running more than three at once adds up quickly.',
    policyLabel: 'When Claude asks for something unexpected',
    policyAsk: 'Ask me',
    policyAskHint: 'A dialog shows exactly what is requested, and you approve or deny.',
    policyUnattended: 'Unattended',
    policyUnattendedHint: 'It is denied automatically, recorded in the history, and the flow continues.',
    settingsSaved: 'Settings saved.',
    pathsTitle: 'Resolved paths',
    pathHome: 'briefstack home',
    pathConfig: 'Config file',
    pathLibrary: 'Personal library',
    pathProjects: 'Projects folder',
    pathSessions: 'Sessions',
    pathRepo: 'briefstack repository',
    pathAllowed: 'Folders Claude may write to',
    navNew: 'New project',
    creationInProgress: 'Creation in progress',
    newTitle: 'New project',
    creationLabel: 'Creation',
    ideaLabel: 'Describe your idea',
    ideaHint: 'In your own words. briefstack asks for whatever else it needs.',
    ideaStart: 'Start',
    ideaStarting: 'Starting…',
    limitMessage: 'The limit of creations at the same time is reached. Finish or cancel one, or raise the limit in Settings.',
    creationsOpen: 'See the creations',
    usageAddsUp: (running: number) =>
      `${running === 1 ? 'One creation is' : `${running} creations are`} already running. Each one uses your plan, so usage adds up.`,
    navCreations: 'Creations',
    creationsTitle: 'Creations in progress',
    creationsEmpty: 'No creation is running.',
    creationsCount: (active: number, limit: number) => `${active} of ${limit} at the same time.`,
    colIdea: 'Idea',
    colStep: 'Step',
    colWaiting: 'Waiting for',
    colStarted: 'Started',
    colWhen: 'When',
    colLastStep: 'Last step',
    colSession: 'Session',
    projectKind: 'Project',
    waitingFor: (kind: string): string => {
      const labels: Record<string, string> = {
        question: 'your answers',
        permission: 'a permission',
        spec: 'the spec approval',
        grant: 'an output folder',
        reply: 'your reply',
        cancelling: 'cancelling',
        working: 'nothing yet: it is working',
      };
      return labels[kind] ?? kind;
    },
    openCreation: 'Open',
    pendingFor: (idea: string) => `For the creation: ${idea}`,
    recentTitle: 'Recent creations',
    recentEmpty: 'None since the app started.',
    policyShown: (policy: string) =>
      `Unexpected permission requests: ${policy === 'unattended' ? 'denied automatically (unattended)' : 'asked to you'}.`,
    progressTitle: 'Progress',
    stepLabel: (step: string): string => {
      const labels: Record<string, string> = {
        idea: 'Idea',
        'gap-analysis': 'Gap analysis',
        interview: 'Interview',
        research: 'Research',
        spec: 'Spec',
        generate: 'Generate',
        'validate-review': 'Validate and review',
        learn: 'Learn',
        handoff: 'Hand-off',
      };
      return labels[step] ?? step;
    },
    stepState: (state: string): string => {
      const labels: Record<string, string> = { waiting: 'waiting', running: 'running', ok: 'done', skipped: 'skipped', failed: 'failed' };
      return labels[state] ?? state;
    },
    agentsNow: 'Working now',
    mainSessionWorking: 'the main session',
    statusWaiting: 'Waiting for your answer.',
    statusWorking: 'Working…',
    awaitingReplyTitle: 'The session is waiting for a reply',
    awaitingReplyBody:
      'Claude ended its turn without asking anything on this page. This is its last message. Reply below, or cancel the creation.',
    cancellingNote: 'Cancelling: the flow is closing the session at its next step. Nothing is cut halfway.',
    streamLost: 'Connection lost. Reconnecting…',
    cancelCreation: 'Cancel creation',
    cancelTitle: 'Cancel this creation?',
    cancelBody: 'The flow stops at its next step and closes the session as cancelled. Files it already wrote stay where they are.',
    cancelKeep: 'Keep going',
    questionsTitle: 'The flow needs your answers',
    ownAnswer: 'Or write your own answer',
    sendAnswers: 'Send answers',
    answerEveryQuestion: 'Choose an option or write your own answer for every question.',
    sending: 'Sending…',
    answerStale: 'The page was out of date and has been refreshed.',
    permissionTitle: 'Permission request',
    permissionBy: (agent: string | undefined) => (agent === undefined ? 'Asked by the main session' : `Asked by the ${agent} agent`),
    permissionWhat: 'It wants to do exactly this:',
    allow: 'Allow',
    deny: 'Deny',
    specTitle: 'Approve the spec',
    specNone: 'The summary is not available.',
    approve: 'Approve',
    requestChanges: 'Request changes',
    changeLabel: 'What should change?',
    sendChanges: 'Send changes',
    specSlug: 'Slug',
    specType: 'Type',
    specLanguage: 'Language',
    grantTitle: 'Allow an output folder',
    grantBody: (dir: string) =>
      `The project would be created in ${dir}, outside your projects folder. Allow writing there for this creation only? The folder is created if it does not exist, and nothing is saved in any settings file.`,
    grantAllow: 'Allow this folder',
    grantDeny: 'Do not allow',
    resultCompleted: 'Your project is ready.',
    resultCompletedNoProject: 'The creation finished.',
    resultCancelled: 'The creation was cancelled.',
    resultFailed: 'The creation failed.',
    resultInterrupted: 'The creation was interrupted before it finished.',
    resultProject: 'Project',
    resultOpen: 'Open the project page',
    resultNextSteps: 'The project page has the next steps and the command to open it.',
    resultNoProject: 'No project was recorded for this creation.',
    deniedTitle: 'Requests that were denied',
    deniedPolicy: 'Denied automatically because the permission policy is unattended.',
    deniedGuard: 'Refused by the guard.',
    deniedNone: 'None.',
    startAnother: 'Start another project',
    folderWillBeCreated: 'This folder does not exist yet. It will be created when you save.',
    errInvalidAnswer: 'That answer was not accepted.',
    errNoReply: 'The session is no longer waiting for a reply. The page has been refreshed.',
    errLibraryBusy: 'Another change to the library is still running. Try again in a moment.',
    replyLabel: 'Your reply',
    replyHint: 'Sent to the session as your message.',
    sendShortcut: 'Ctrl+Enter sends',
    replySend: 'Send reply',

    navChat: 'Chat',
    chatTitle: 'Chat',
    chatIntro: 'Ask about your projects, library, creations and usage. Every change it proposes waits for you here.',
    chatOpen: 'Open the chat',
    chatClose: 'Close the chat',
    chatOpenPage: 'Full page',
    chatEmpty: 'No messages yet.',
    chatThinking: 'Claude is answering…',
    chatWaitingCard: 'Waiting for your answer on the card above.',
    chatModel: (model: string, effort: string) => `Model ${model}, effort ${effort} (from the usage profile).`,
    chatMessageLabel: 'Your message',
    chatMessageHint: 'What the chat reads is data: it never acts on it without asking you.',
    chatSend: 'Send',
    chatYou: 'You',
    chatClaude: 'Claude',
    chatUsedTool: (name: string) => `Used ${name}`,
    chatToolFailed: 'It did not work:',
    chatSources: 'From:',
    chatNew: 'New chat',
    chatNewTitle: 'Start a new chat?',
    chatNewBody: 'This chat is kept, read-only, in the past chats. A proposal waiting for your answer is dropped.',
    chatPast: 'Past chats',
    chatPastEmpty: 'No past chats.',
    chatReadOnly: 'A past chat, read-only.',
    chatBackToActive: 'Back to the chat',
    chatUntitled: 'Untitled',
    chatNoticeResumeFailed: 'The previous conversation could not be restored for Claude. A new one started; the messages above stay here.',
    chatNoticeSessionError: 'The chat session stopped with an error.',
    cardTitle: 'Claude proposes an action',
    cardConfirm: 'Confirm',
    cardDecline: 'Decline',
    cardState: (state: string): string => {
      const labels: Record<string, string> = {
        pending: 'Waiting for your answer',
        confirmed: 'Confirmed and done',
        declined: 'Declined: nothing was done',
        failed: 'Confirmed, but it failed',
        expired: 'Expired: nothing was done',
        stale: 'The note changed after this proposal, so nothing was saved. Ask me for a new proposal',
      };
      return labels[state] ?? state;
    },
    cardStartCreation: 'Start a new creation with this idea:',
    cardStartNote: (profile: string, active: number, limit: number) =>
      `Usage profile ${profile}. ${active} of ${limit} creations at once are running${active > 0 ? '; plan usage adds up' : ''}.`,
    cardCancelCreation: 'Cancel this creation:',
    cardCancelStep: (step: string) => `Now at: ${step}.`,
    cardNoteChange: (file: string, mode: string) =>
      `${mode === 'create' ? 'Create' : mode === 'append' ? 'Add to the end of' : 'Rewrite'} the note ${file}${mode === 'append' ? ' (as a dated addition)' : ''}, with one library commit:`,
    cardNoteCounts: (added: number, removed: number) => `${added} ${added === 1 ? 'line' : 'lines'} added, ${removed} removed.`,
    cardSkipped: (count: number) => `… ${count} unchanged ${count === 1 ? 'line' : 'lines'} …`,
    cardUsageProfile: (from: string, to: string, label: string) => `Switch the usage profile from ${from} to ${to} (${label}).`,
    cardOpen: 'Open',
    // Improvements (phase 5).
    navImprove: 'Improvements',
    improveTitle: 'Improvements',
    improveIntro:
      "briefstack can improve its own creation flow: the agents' and the skill's instructions and the library's templates and rules. A proposal is prepared apart, checked and tested, and changes nothing until you approve it here.",
    improveSuggestions: 'Suggestions after creations',
    improveNoSuggestions: 'No suggestions yet. They appear when a creation finishes with something worth improving.',
    suggestionText: (kind: string, p: { count?: number; outcome?: string; steps?: string[]; tools?: string[] }, target: string): string => {
      switch (kind) {
        case 'failure':
          return `The creation ended ${p.outcome === 'interrupted' ? 'interrupted' : 'failed'}${p.steps?.length ? ` (failed steps: ${p.steps.join(', ')})` : ''}. Look at ${target}.`;
        case 'textQuestions':
          return `The creation waited ${p.count ?? 0} time(s) for an answer in plain text, which this page cannot send. ${target} could ask through its tools instead.`;
        case 'denials':
          return `The guard denied ${p.count ?? 0} tool call(s) (${(p.tools ?? []).join(', ')}). ${target} could avoid them.`;
        case 'reviewRounds':
          return `The review took ${p.count ?? 0} rounds. ${target} could get it right the first time.`;
        case 'lessons':
          return `The creation wrote ${p.count ?? 0} new lesson(s). ${target} could turn them into a general rule.`;
        default:
          return kind;
      }
    },
    suggestionRequest: (kind: string, text: string): string =>
      `Improve the creation flow for this case: ${text} Keep the change generic, for any user.${kind === 'lessons' ? ' Use the lessons as evidence.' : ''}`,
    suggestionPrepare: 'Prepare an improvement',
    suggestionPrepared: 'Prepared:',
    suggestionFrom: (idea: string) => `After "${idea}"`,
    improvePrepareTitle: 'Prepare an improvement',
    improveRequestLabel: 'What should change?',
    improveLessonsLabel: 'Use the lessons note as evidence',
    improveUsesPlan: (model: string) =>
      `An improvement session runs with ${model} and uses part of your plan. Then the server checks and tests the change; nothing is applied until you approve it.`,
    improvePrepareButton: 'Prepare',
    improveRunning: 'An improvement session is running:',
    improveProposals: 'Proposals',
    improveNoProposals: 'No proposals yet. Ask for one here or in the chat.',
    improveHistory: 'Applied improvements',
    improveNoHistory: 'No improvement has been applied yet.',
    colRequest: 'Request',
    colFiles: 'Files',
    colUpdated: 'Updated',
    colCommit: 'Commit',
    openProposal: 'Open',
    proposalStatus: (status: string): string =>
      ({
        preparing: 'Being prepared',
        verifying: 'Being checked',
        ready: 'Ready to review',
        rejected: 'Rejected by the checks',
        failed: 'Failed',
        waiting: 'Approved, waiting',
        applied: 'Applied',
        revertWaiting: 'Revert waiting',
        reverted: 'Reverted',
        discarded: 'Discarded',
      })[status] ?? status,
    proposalHeading: (id: string) => `Proposal ${id}`,
    proposalKind: 'Improvement proposal',
    proposalDecision: 'Your decision',
    proposalDecisionNote: 'Decide after reading the changes and the checks above.',
    proposalChecks: 'Checks',
    proposalMaking: 'How it was prepared',
    proposalRequest: 'Request',
    proposalExpected: 'What should be different',
    proposalEvidence: 'Evidence',
    proposalChanges: 'Changes',
    proposalRationale: 'Why:',
    proposalNoChanges: 'No file changed.',
    proposalValidation: 'Checks on the change',
    proposalValidationOk:
      'All passed: only allowed files changed, frontmatter and locked blocks kept, no secrets, personal paths or data, or text from your profile or lessons.',
    problemKind: (kind: string): string =>
      ({
        forbiddenPath: 'A file an improvement may not change',
        notModified: 'A file added, deleted or renamed',
        mode: 'File mode changed',
        notText: 'Not plain text',
        frontmatter: 'Frontmatter changed',
        locked: 'Locked block touched',
        secret: 'Looks like a secret',
        personalPath: 'Personal path',
        personalData: 'Personal data (an e-mail, your name or a project of yours)',
        profileText: 'Text from your profile',
        lessonText: 'Text from your lessons',
        noChanges: 'Nothing changed',
        unexplained: 'No rationale given',
      })[kind] ?? kind,
    proposalTests: 'Build, lint and tests',
    testStep: (name: string, ok: boolean, seconds: number) => `${name}: ${ok ? 'passed' : 'failed'} (${seconds} s)`,
    proposalNotTested: 'Not run: the checks on the change must pass first.',
    safetyFlaggedTitle: 'Safety notice: this change may weaken a rule',
    safetyFlaggedNote: (model: string) =>
      `A cheap model (${model}) read the diff and says so. It does not block approving: read the changes below before you decide.`,
    safetyClear: (model: string) => `Safety review (${model}): it found no rule about safety, permissions, writes or asking in text weakened.`,
    safetyUnavailable: (reason: string) => `Safety review: no answer (${reason}). Read the diff with that in mind.`,
    proposalRounds: 'Rounds',
    roundLine: (n: number, outcome: string | undefined, denials: number) =>
      `Round ${n}: ${outcome === 'submitted' ? 'proposal handed in' : outcome === 'noProposal' ? 'no proposal handed in' : outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'interrupted' : 'running'}${denials > 0 ? `, ${denials} call(s) denied by the guard` : ''}.`,
    roundFeedback: 'You asked:',
    proposalPreparing: 'The improvement session is running. This page updates by itself.',
    proposalVerifying: 'The server is checking and testing the change.',
    proposalWaiting: (blockers: string) => `Approved. It applies as soon as no creation is running (now: ${blockers}).`,
    proposalRevertWaitingText: (blockers: string) => `The revert runs as soon as no creation is running (now: ${blockers}).`,
    proposalApplied: (commit: string) => `Applied as commit ${commit} on your branch. It is not pushed.`,
    proposalReverted: (commit: string) => `Reverted with commit ${commit}.`,
    proposalDiscarded: 'Discarded: its branch and worktree were removed.',
    proposalApprove: 'Approve and apply',
    proposalApproveTitle: 'Apply this improvement?',
    proposalApproveBody: 'It becomes one commit on your branch (not pushed). If a creation is running, it waits until none is.',
    proposalAskChanges: 'Ask for changes',
    proposalChangesLabel: 'What should be different?',
    proposalSendChanges: 'Start a new round',
    proposalDiscard: 'Discard',
    proposalDiscardTitle: 'Discard this proposal?',
    proposalDiscardBody: 'Its branch and worktree are removed. Nothing in your repository changes.',
    proposalRevert: 'Revert',
    proposalRevertTitle: 'Revert this improvement?',
    proposalRevertBody: 'A revert commit undoes its changes and keeps later ones. If a creation is running, it waits until none is.',
    proposalCheck: 'Run the real check',
    proposalCheckTitle: (name: string) => `Real check: ${name}`,
    realCheckState: (state: string) => ({ running: 'Running…', passed: 'Passed', failed: 'Failed' })[state] ?? state,
    cardPrepareImprovement: (model: string) =>
      `Prepare an improvement of briefstack's creation flow. An improvement session runs with ${model} and uses part of your plan; you review and approve the result on its page:`,
    cardEvidence: (sessions: number, lessons: boolean, suggestion: boolean) =>
      `Evidence: ${[sessions > 0 ? `${sessions} session(s)` : '', lessons ? 'the lessons note' : '', suggestion ? 'a suggestion' : ''].filter(Boolean).join(', ') || 'none'}.`,
    chatNoticeSuggestions: 'A creation finished. Suggestions to improve the flow:',
    creationSuggestions: 'What could be improved',
    errImproveBusy: 'An improvement session is already running. Wait for it to finish.',
    errImproveConflict: (file: string) => `${file} changed since the proposal was prepared, in the same lines. Ask for changes to prepare a new round.`,
    errImproveBaseChanged: (file: string, branch: string) => `${file} changed on ${branch} since the proposal was prepared. Ask for changes: the new round starts from the current ${branch} and is checked and tested again.`,
    errImproveStaleReview: 'This proposal was checked again since this page showed it. Reload, review the new round and approve that one.',
    errImproveUncommitted: (file: string) => `${file} has changes that are not committed in the part the proposal changes. Commit or discard them first.`,
    errImproveNotOnBranch: (branch: string) => `Your repository is not on ${branch}, where the proposal was prepared. Switch back and try again.`,
    errImproveMoved: 'The branch moved while the change was being applied. Nothing changed; try again.',
    errImproveNoRepo: 'The briefstack repository cannot take an improvement now (it must be a git repository on a branch, outside the briefstack home).',
    errImproveWrongState: 'The proposal cannot do that in its current state. Reload the page.',
  },
  es: {
    title: 'briefstack',
    connecting: 'Conectando…',
    noToken: 'Abre la dirección que briefstack web ha mostrado en la terminal, incluida la parte después de #.',
    rejected: 'El servidor ha rechazado la petición. Reinicia briefstack web y abre la nueva dirección.',
    unreachable: 'No se puede contactar con el servidor. ¿Sigue en marcha briefstack web?',

    navLabel: 'Principal',
    themeLabel: 'Tema',
    themeName: (theme: 'system' | 'light' | 'dark') => ({ system: 'Sistema', light: 'Claro', dark: 'Oscuro' })[theme],
    navProjects: 'Proyectos',
    navLibrary: 'Librería',
    navUsage: 'Uso',
    navSettings: 'Ajustes',

    loading: 'Cargando…',
    retry: 'Reintentar',
    back: 'Volver',
    save: 'Guardar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    copy: 'Copiar',
    copied: 'Copiado',
    copyFailed: 'El navegador no ha permitido copiar.',
    none: 'Ninguno',
    notFound: 'No hay nada aquí.',

    errGeneric: (code: string) => `Algo ha ido mal (${code}).`,
    errSecret: (lines: readonly number[]) =>
      `La nota parece contener un secreto (línea ${lines.join(', ')}). Quítalo y guarda otra vez. No se ha guardado nada.`,
    errSecretNoLines: 'La nota parece contener un secreto. Quítalo y guarda otra vez. No se ha guardado nada.',
    errRelativePath: 'Usa una ruta completa, como C:\\Users\\tu\\proyectos o /home/tu/proyectos, o una que empiece por ~.',
    errForbiddenOutput: (root: string) =>
      root === 'library'
        ? 'Esa carpeta se solapa con tu librería personal. Elige otra.'
        : root === 'repo'
          ? 'Esa carpeta se solapa con el repositorio de briefstack. Elige otra.'
          : 'Esa carpeta se solapa con una carpeta protegida (la de briefstack, la de Claude Code o AppData). Elige otra.',
    errNotADirectory: 'Esa ruta es un archivo, no una carpeta.',
    errNoteNotFound: 'Esa nota no existe.',
    errCommitNotFound: 'Ese commit no existe.',
    errDirtyTree: 'La librería tiene cambios sin guardar. Guárdalos o descártalos primero.',
    errRevertConflict: 'No se pudo revertir el commit sin conflictos. La librería no ha cambiado.',
    errUnknownProfile: 'Ese perfil de uso no existe.',
    errInvalidBody: 'El servidor no ha aceptado esos valores.',

    projectsTitle: 'Proyectos',
    projectsEmpty: 'Aún no hay proyectos. Crea uno con /new-project.',
    colName: 'Nombre',
    colTarget: 'Destino',
    colStatus: 'Estado',
    colProfile: 'Perfil',
    colCreated: 'Creado',
    colPath: 'Ruta',
    invalidNote: 'Bloque de estado no válido',
    invalidIssues: (issues: readonly string[]) => `Problemas: ${issues.join('; ')}`,
    allProjects: 'Todos los proyectos',
    summary: 'Resumen',
    statusBlock: 'Estado',
    targetChosenBy: 'Destino elegido por',
    chooser: (who: string): string => (who === 'user' ? 'ti' : who === 'architect' ? 'el arquitecto, según la regla del destino' : who),
    targetReason: 'Por qué este destino',

    panelTitle: 'Agentes',
    panelMain: 'Sesión principal',
    nodeStatus: (status: string): string =>
      ({
        waiting: 'Esperándote',
        running: 'En marcha',
        done: 'Terminado',
        failed: 'Falló',
        cancelled: 'Cancelado',
        interrupted: 'Interrumpido',
        noEnd: 'Sin final registrado',
      })[status] ?? status,
    panelModel: 'Modelo',
    panelEffort: 'Esfuerzo',
    panelStarted: 'Empezó',
    panelDuration: 'Duración',
    panelNow: 'Ahora',
    panelNoTool: 'Ninguna herramienta en uso',
    panelToolCalls: (n: number): string => (n === 1 ? '1 llamada a herramienta' : `${n} llamadas a herramientas`),
    panelDenialCount: (n: number): string => (n === 1 ? '1 denegada' : `${n} denegadas`),
    panelAsks: (kind: string): string =>
      ({
        question: 'Te hace una pregunta',
        permission: 'Pide un permiso',
        spec: 'Te pide aprobar la spec',
        grant: 'Pide una carpeta',
      })[kind] ?? 'Te pide algo',
    panelGoToControl: 'Ir a la respuesta',
    panelNoAgents: 'Todavía no ha empezado ningún subagente.',
    panelTimeline: 'Línea de tiempo',
    panelTimelineHint: 'Una fila por agente. Elige una fila para ver sus detalles.',
    panelDetail: 'Detalles',
    panelDenials: 'Llamadas denegadas',
    panelNoDenials: 'No se denegó nada.',
    denialBy: (by: string): string =>
      ({ guard: 'por el guardián', policy: 'por el ajuste desatendido', user: 'por ti' })[by] ?? by,
    panelTextView: 'Vista de texto de los agentes',
    panelUsage: 'Uso del plan',
    panelUsageStart: 'Al empezar',
    panelUsageNow: 'Última lectura',
    panelUsageLine: (fiveHour: string, sevenDay: string): string => `Ventana de 5 horas ${fiveHour} · ventana de 7 días ${sevenDay}`,
    panelUsageNone: 'No disponible para esta sesión.',
    panelUsageReading: 'Leyendo el uso del plan…',
    panelUsageHint: 'De la misma lectura que /usage. Sin cifras de tokens ni de coste.',
    targetOutside: 'fuera de las carpetas permitidas',
    targetRoot: (root: string): string =>
      ({ session: 'carpeta de la sesión', projects: 'carpeta de proyectos', repo: 'briefstack' })[root] ?? root,
    panelSessionTitle: 'Sesión de creación',
    panelSessionStatus: (status: string, outcome: string | undefined): string =>
      status === 'running'
        ? 'En curso'
        : status === 'interrupted'
          ? 'Interrumpida'
          : ({ completed: 'Completada', cancelled: 'Cancelada', failed: 'Falló' })[outcome ?? ''] ?? 'Terminada',
    panelBadLines: (n: number): string => `${n} línea(s) registradas no se pudieron leer y se omiten.`,
    panelOpen: 'Abrir el panel de agentes',
    panelBack: 'Volver a los proyectos',
    sessionId: 'Sesión de creación',
    timelineTitle: 'Historial de creación',
    timelineEmpty: 'Este proyecto no tiene historial.',
    stepColumn: 'Paso',
    startedColumn: 'Inicio',
    finishedColumn: 'Fin',
    resultColumn: 'Resultado',
    stillRunning: 'sin terminar',
    nextSteps: 'Próximos pasos',
    instructions: 'Instrucciones para la app de Claude',
    copyInstructions: 'Copiar INSTRUCTIONS.md',
    copyPath: 'Copiar ruta',
    openInClaude: 'Abrir en Claude Code',
    openHint: 'Ejecuta estos dos comandos en una terminal:',
    copyCommand: 'Copiar comandos',
    unfinishedTitle: 'Creaciones interrumpidas y canceladas',
    unfinishedEmpty: 'Ninguna.',
    lastStep: (step: string | undefined) => (step === undefined ? 'antes del primer paso' : `último paso: ${step}`),
    outcome: (value: string | undefined): string => {
      switch (value) {
        case 'ok':
          return 'correcto';
        case 'completed':
          return 'completada';
        case 'cancelled':
          return 'cancelada';
        case 'failed':
          return 'fallida';
        case 'interrupted':
          return 'interrumpida';
        case 'in-progress':
          return 'en curso';
        case 'finished':
          return 'terminada';
        default:
          return value ?? '—';
      }
    },

    libraryTitle: 'Librería personal',
    sectionIndex: 'Índice',
    sectionProfile: 'Perfil',
    sectionProjects: 'Notas de proyectos',
    sectionLog: 'Registros de sesiones',
    sectionSkills: 'Skills',
    sectionLessons: 'Lecciones',
    sectionHistory: 'Historial',
    noNotes: 'No hay notas en esta sección.',
    indexReadOnly: 'briefstack actualiza INDEX.md cuando guardas una nota.',
    editorLabel: 'Markdown',
    previewLabel: 'Vista previa',
    unsaved: 'Cambios sin guardar',
    saveMode: (mode: string): string => {
      switch (mode) {
        case 'append':
          return 'Guardado. Lo que has añadido quedó bajo la fecha de hoy.';
        case 'create':
          return 'Guardado. La nota se ha creado.';
        case 'unchanged':
          return 'No ha cambiado nada.';
        default:
          return 'Guardado.';
      }
    },
    redactedWarning:
      'Algunas líneas parecen secretos y se ocultan como [redacted]. Quita esas líneas para guardar, así no se sobrescribe el texto oculto.',
    historyTitle: 'Historial de la librería',
    historyEmpty: 'La librería aún no tiene historial.',
    filesChanged: (count: number) => (count === 1 ? '1 archivo' : `${count} archivos`),
    revert: 'Revertir',
    revertTitle: '¿Revertir este commit?',
    revertBody: (shortSha: string, subject: string) =>
      `Se añade un commit nuevo que deshace ${shortSha} («${subject}»). No se borra nada del historial.`,
    revertConfirm: 'Revertir commit',
    reverted: (shortSha: string) => `Se ha revertido ${shortSha}.`,

    usageTitle: 'Perfil de uso',
    usageIntro: 'Decide qué modelos y cuánto esfuerzo usa el flujo de creación. Más esfuerzo da resultados más completos y gasta más de tu plan.',
    usageSlider: 'Nivel de uso',
    levelSaver: 'Ahorro',
    levelBalanced: 'Equilibrado',
    levelMax: 'Máximo',
    levelHint: (level: string): string => {
      switch (level) {
        case 'saver':
          return 'El menor consumo. Modelos más ligeros, poca investigación y una revisión corta.';
        case 'max':
          return 'El mayor consumo. Los modelos más potentes, investigación más profunda y más rondas de revisión.';
        default:
          return 'Consumo moderado con buenos resultados. Una mezcla de modelos y una revisión normal.';
      }
    },
    usageActive: (label: string) => `Activo: ${label}`,
    usageCustomActive: 'Hay un preset propio activo.',
    usageChatModel: (model: string, effort: string) => `Chat: ${model}, esfuerzo ${effort}.`,
    presetsLabel: 'Tus presets',
    presetsChoose: 'Elige un preset…',
    presetsNone: 'No has definido ningún preset.',
    usageSaved: (profile: string) => `Perfil cambiado a ${profile}.`,
    warningsTitle: 'Avisos',
    warningsNone: 'Sin avisos.',
    warnDrift: (file: string, field: string) => `${file}: ${field} difiere del archivo de agente guardado en git.`,
    warnEnv: (variable: string) => `La variable de entorno ${variable} anula el perfil.`,
    openUsageHint: 'Para ver tu consumo real, escribe /usage en Claude Code.',

    settingsTitle: 'Ajustes',
    projectsDirLabel: 'Carpeta de proyectos',
    projectsDirHint: 'Donde van los proyectos nuevos. Si la carpeta no existe, se crea.',
    languageLabel: 'Idioma',
    langSystem: 'Seguir el sistema',
    langEn: 'English',
    langEs: 'Español',
    maxActiveLabel: 'Creaciones a la vez',
    maxActiveHint: 'Cuántas creaciones pueden estar en marcha a la vez. Por defecto, 2.',
    maxActiveNote: 'Cada creación usa tu plan: con más de tres a la vez, el consumo sube rápido.',
    policyLabel: 'Cuando Claude pide algo inesperado',
    policyAsk: 'Preguntarme',
    policyAskHint: 'Un diálogo muestra exactamente lo que se pide y tú apruebas o deniegas.',
    policyUnattended: 'Desatendido',
    policyUnattendedHint: 'Se deniega automáticamente, queda en el historial y el flujo continúa.',
    settingsSaved: 'Ajustes guardados.',
    pathsTitle: 'Rutas resueltas',
    pathHome: 'Carpeta de briefstack',
    pathConfig: 'Archivo de configuración',
    pathLibrary: 'Librería personal',
    pathProjects: 'Carpeta de proyectos',
    pathSessions: 'Sesiones',
    pathRepo: 'Repositorio de briefstack',
    pathAllowed: 'Carpetas donde Claude puede escribir',
    navNew: 'Proyecto nuevo',
    creationInProgress: 'Creación en curso',
    newTitle: 'Proyecto nuevo',
    creationLabel: 'Creación',
    ideaLabel: 'Describe tu idea',
    ideaHint: 'Con tus palabras. briefstack pregunta lo que le falte.',
    ideaStart: 'Empezar',
    ideaStarting: 'Empezando…',
    limitMessage: 'Se ha llegado al límite de creaciones a la vez. Termina o cancela una, o sube el límite en Ajustes.',
    creationsOpen: 'Ver las creaciones',
    usageAddsUp: (running: number) =>
      `${running === 1 ? 'Ya hay una creación' : `Ya hay ${running} creaciones`} en marcha. Cada una usa tu plan, así que el consumo se suma.`,
    navCreations: 'Creaciones',
    creationsTitle: 'Creaciones en curso',
    creationsEmpty: 'No hay ninguna creación en marcha.',
    creationsCount: (active: number, limit: number) => `${active} de ${limit} a la vez.`,
    colIdea: 'Idea',
    colStep: 'Paso',
    colWaiting: 'Espera',
    colStarted: 'Empezó',
    colWhen: 'Cuándo',
    colLastStep: 'Último paso',
    colSession: 'Sesión',
    projectKind: 'Proyecto',
    waitingFor: (kind: string): string => {
      const labels: Record<string, string> = {
        question: 'tus respuestas',
        permission: 'un permiso',
        spec: 'que apruebes la spec',
        grant: 'una carpeta de salida',
        reply: 'tu respuesta',
        cancelling: 'cancelándose',
        working: 'nada aún: está trabajando',
      };
      return labels[kind] ?? kind;
    },
    openCreation: 'Abrir',
    pendingFor: (idea: string) => `Para la creación: ${idea}`,
    recentTitle: 'Creaciones recientes',
    recentEmpty: 'Ninguna desde que arrancó la app.',
    policyShown: (policy: string) =>
      `Peticiones de permiso inesperadas: ${policy === 'unattended' ? 'se deniegan solas (desatendido)' : 'te las pregunto'}.`,
    progressTitle: 'Progreso',
    stepLabel: (step: string): string => {
      const labels: Record<string, string> = {
        idea: 'Idea',
        'gap-analysis': 'Análisis de huecos',
        interview: 'Entrevista',
        research: 'Investigación',
        spec: 'Spec',
        generate: 'Generación',
        'validate-review': 'Validación y revisión',
        learn: 'Aprendizaje',
        handoff: 'Entrega',
      };
      return labels[step] ?? step;
    },
    stepState: (state: string): string => {
      const labels: Record<string, string> = { waiting: 'pendiente', running: 'en curso', ok: 'hecho', skipped: 'omitido', failed: 'fallido' };
      return labels[state] ?? state;
    },
    agentsNow: 'Trabajando ahora',
    mainSessionWorking: 'la sesión principal',
    statusWaiting: 'Esperando tu respuesta.',
    statusWorking: 'Trabajando…',
    awaitingReplyTitle: 'La sesión espera una respuesta',
    awaitingReplyBody:
      'Claude ha terminado su turno sin preguntar nada en esta página. Este es su último mensaje. Contesta abajo o cancela la creación.',
    cancellingNote: 'Cancelando: el flujo cierra la sesión en su próximo paso. Nada se corta a medias.',
    streamLost: 'Se perdió la conexión. Reconectando…',
    cancelCreation: 'Cancelar creación',
    cancelTitle: '¿Cancelar esta creación?',
    cancelBody: 'El flujo se detiene en su próximo paso y cierra la sesión como cancelada. Lo que ya escribió se queda donde está.',
    cancelKeep: 'Seguir',
    questionsTitle: 'El flujo necesita tus respuestas',
    ownAnswer: 'O escribe tu propia respuesta',
    sendAnswers: 'Enviar respuestas',
    answerEveryQuestion: 'Elige una opción o escribe tu propia respuesta en cada pregunta.',
    sending: 'Enviando…',
    answerStale: 'La página estaba desactualizada y se ha refrescado.',
    permissionTitle: 'Petición de permiso',
    permissionBy: (agent: string | undefined) => (agent === undefined ? 'Lo pide la sesión principal' : `Lo pide el agente ${agent}`),
    permissionWhat: 'Quiere hacer exactamente esto:',
    allow: 'Permitir',
    deny: 'Denegar',
    specTitle: 'Aprueba la spec',
    specNone: 'El resumen no está disponible.',
    approve: 'Aprobar',
    requestChanges: 'Pedir cambios',
    changeLabel: '¿Qué hay que cambiar?',
    sendChanges: 'Enviar cambios',
    specSlug: 'Slug',
    specType: 'Tipo',
    specLanguage: 'Idioma',
    grantTitle: 'Permitir una carpeta de salida',
    grantBody: (dir: string) =>
      `El proyecto se crearía en ${dir}, fuera de tu carpeta de proyectos. ¿Permites escribir ahí solo para esta creación? La carpeta se crea si no existe y no se guarda nada en ningún archivo de ajustes.`,
    grantAllow: 'Permitir esta carpeta',
    grantDeny: 'No permitir',
    resultCompleted: 'Tu proyecto está listo.',
    resultCompletedNoProject: 'La creación ha terminado.',
    resultCancelled: 'La creación se ha cancelado.',
    resultFailed: 'La creación ha fallado.',
    resultInterrupted: 'La creación se interrumpió antes de terminar.',
    resultProject: 'Proyecto',
    resultOpen: 'Abrir la página del proyecto',
    resultNextSteps: 'La página del proyecto tiene los próximos pasos y el comando para abrirlo.',
    resultNoProject: 'No se registró ningún proyecto para esta creación.',
    deniedTitle: 'Peticiones denegadas',
    deniedPolicy: 'Denegada automáticamente porque la política de permisos es desatendido.',
    deniedGuard: 'Rechazada por el guardián.',
    deniedNone: 'Ninguna.',
    startAnother: 'Empezar otro proyecto',
    folderWillBeCreated: 'Esta carpeta aún no existe. Se creará al guardar.',
    errInvalidAnswer: 'Esa respuesta no se ha aceptado.',
    errNoReply: 'La sesión ya no espera una respuesta. La página se ha actualizado.',
    errLibraryBusy: 'Otro cambio en la biblioteca sigue en curso. Inténtalo de nuevo en un momento.',
    replyLabel: 'Tu respuesta',
    replyHint: 'Se envía a la sesión como mensaje tuyo.',
    sendShortcut: 'Ctrl+Intro envía',
    replySend: 'Enviar respuesta',

    navChat: 'Chat',
    chatTitle: 'Chat',
    chatIntro: 'Pregunta por tus proyectos, la biblioteca, las creaciones y el uso. Cada cambio que proponga espera aquí a que lo confirmes.',
    chatOpen: 'Abrir el chat',
    chatClose: 'Cerrar el chat',
    chatOpenPage: 'Página completa',
    chatEmpty: 'Aún no hay mensajes.',
    chatThinking: 'Claude está respondiendo…',
    chatWaitingCard: 'Esperando tu respuesta en la tarjeta de arriba.',
    chatModel: (model: string, effort: string) => `Modelo ${model}, esfuerzo ${effort} (del perfil de uso).`,
    chatMessageLabel: 'Tu mensaje',
    chatMessageHint: 'Lo que el chat lee son datos: nunca actúa por ello sin preguntarte.',
    chatSend: 'Enviar',
    chatYou: 'Tú',
    chatClaude: 'Claude',
    chatUsedTool: (name: string) => `Ha usado ${name}`,
    chatToolFailed: 'No ha funcionado:',
    chatSources: 'De:',
    chatNew: 'Chat nuevo',
    chatNewTitle: '¿Empezar un chat nuevo?',
    chatNewBody: 'Este chat se guarda, solo lectura, en los chats anteriores. Una propuesta que espere tu respuesta se descarta.',
    chatPast: 'Chats anteriores',
    chatPastEmpty: 'No hay chats anteriores.',
    chatReadOnly: 'Un chat anterior, solo lectura.',
    chatBackToActive: 'Volver al chat',
    chatUntitled: 'Sin título',
    chatNoticeResumeFailed: 'No se ha podido recuperar la conversación anterior para Claude. Ha empezado una nueva; los mensajes de arriba se quedan aquí.',
    chatNoticeSessionError: 'La sesión del chat se ha detenido con un error.',
    cardTitle: 'Claude propone una acción',
    cardConfirm: 'Confirmar',
    cardDecline: 'Rechazar',
    cardState: (state: string): string => {
      const labels: Record<string, string> = {
        pending: 'Espera tu respuesta',
        confirmed: 'Confirmada y hecha',
        declined: 'Rechazada: no se ha hecho nada',
        failed: 'Confirmada, pero ha fallado',
        expired: 'Caducada: no se ha hecho nada',
        stale: 'La nota cambió después de esta propuesta y no se ha guardado nada. Pídeme otra propuesta',
      };
      return labels[state] ?? state;
    },
    cardStartCreation: 'Empezar una creación nueva con esta idea:',
    cardStartNote: (profile: string, active: number, limit: number) =>
      `Perfil de uso ${profile}. Hay ${active} de ${limit} creaciones a la vez en marcha${active > 0 ? '; el consumo se suma' : ''}.`,
    cardCancelCreation: 'Cancelar esta creación:',
    cardCancelStep: (step: string) => `Ahora en: ${step}.`,
    cardNoteChange: (file: string, mode: string) =>
      `${mode === 'create' ? 'Crear' : mode === 'append' ? 'Añadir al final de' : 'Reescribir'} la nota ${file}${mode === 'append' ? ' (como añadido con fecha)' : ''}, con un commit en la biblioteca:`,
    cardNoteCounts: (added: number, removed: number) =>
      `${added} ${added === 1 ? 'línea añadida' : 'líneas añadidas'}, ${removed} ${removed === 1 ? 'quitada' : 'quitadas'}.`,
    cardSkipped: (count: number) => `… ${count} ${count === 1 ? 'línea sin cambios' : 'líneas sin cambios'} …`,
    cardUsageProfile: (from: string, to: string, label: string) => `Cambiar el perfil de uso de ${from} a ${to} (${label}).`,
    cardOpen: 'Abrir',
    // Mejoras (fase 5).
    navImprove: 'Mejoras',
    improveTitle: 'Mejoras',
    improveIntro:
      'briefstack puede mejorar su propio flujo de creación: las instrucciones de los agentes y del skill y las plantillas y reglas de la biblioteca. Cada propuesta se prepara aparte, se comprueba y se prueba, y no cambia nada hasta que la apruebas aquí.',
    improveSuggestions: 'Sugerencias tras las creaciones',
    improveNoSuggestions: 'Aún no hay sugerencias. Aparecen cuando una creación termina con algo que merece mejorarse.',
    suggestionText: (kind: string, p: { count?: number; outcome?: string; steps?: string[]; tools?: string[] }, target: string): string => {
      switch (kind) {
        case 'failure':
          return `La creación terminó ${p.outcome === 'interrupted' ? 'interrumpida' : 'con fallo'}${p.steps?.length ? ` (pasos fallidos: ${p.steps.join(', ')})` : ''}. Revisa ${target}.`;
        case 'textQuestions':
          return `La creación esperó ${p.count ?? 0} vez/veces una respuesta en texto, que esta página no puede enviar. ${target} podría preguntar con sus herramientas.`;
        case 'denials':
          return `El guardián denegó ${p.count ?? 0} llamada(s) (${(p.tools ?? []).join(', ')}). ${target} podría evitarlas.`;
        case 'reviewRounds':
          return `La revisión necesitó ${p.count ?? 0} rondas. ${target} podría acertar a la primera.`;
        case 'lessons':
          return `La creación escribió ${p.count ?? 0} lección(es) nueva(s). ${target} podría convertirlas en una regla general.`;
        default:
          return kind;
      }
    },
    suggestionRequest: (kind: string, text: string): string =>
      `Mejora el flujo de creación para este caso: ${text} Mantén el cambio genérico, válido para cualquier usuario.${kind === 'lessons' ? ' Usa las lecciones como evidencia.' : ''}`,
    suggestionPrepare: 'Preparar una mejora',
    suggestionPrepared: 'Preparada:',
    suggestionFrom: (idea: string) => `Tras «${idea}»`,
    improvePrepareTitle: 'Preparar una mejora',
    improveRequestLabel: '¿Qué debería cambiar?',
    improveLessonsLabel: 'Usar la nota de lecciones como evidencia',
    improveUsesPlan: (model: string) =>
      `Se ejecuta una sesión de mejora con ${model} que consume parte de tu plan. Después el servidor comprueba y prueba el cambio; no se aplica nada hasta que lo apruebes.`,
    improvePrepareButton: 'Preparar',
    improveRunning: 'Hay una sesión de mejora en marcha:',
    improveProposals: 'Propuestas',
    improveNoProposals: 'Aún no hay propuestas. Pide una aquí o en el chat.',
    improveHistory: 'Mejoras aplicadas',
    improveNoHistory: 'Todavía no se ha aplicado ninguna mejora.',
    colRequest: 'Petición',
    colFiles: 'Archivos',
    colUpdated: 'Actualizada',
    colCommit: 'Commit',
    openProposal: 'Abrir',
    proposalStatus: (status: string): string =>
      ({
        preparing: 'Preparándose',
        verifying: 'Comprobándose',
        ready: 'Lista para revisar',
        rejected: 'Rechazada por las comprobaciones',
        failed: 'Fallida',
        waiting: 'Aprobada, en espera',
        applied: 'Aplicada',
        revertWaiting: 'Reversión en espera',
        reverted: 'Revertida',
        discarded: 'Descartada',
      })[status] ?? status,
    proposalHeading: (id: string) => `Propuesta ${id}`,
    proposalKind: 'Propuesta de mejora',
    proposalDecision: 'Tu decisión',
    proposalDecisionNote: 'Decide después de leer los cambios y las comprobaciones de arriba.',
    proposalChecks: 'Comprobaciones',
    proposalMaking: 'Cómo se preparó',
    proposalRequest: 'Petición',
    proposalExpected: 'Qué debería cambiar',
    proposalEvidence: 'Evidencia',
    proposalChanges: 'Cambios',
    proposalRationale: 'Por qué:',
    proposalNoChanges: 'No cambió ningún archivo.',
    proposalValidation: 'Comprobaciones del cambio',
    proposalValidationOk:
      'Todo correcto: solo cambian archivos permitidos, se mantienen el frontmatter y los bloques bloqueados, y no hay secretos, rutas ni datos personales, ni texto de tu perfil o tus lecciones.',
    problemKind: (kind: string): string =>
      ({
        forbiddenPath: 'Un archivo que una mejora no puede cambiar',
        notModified: 'Un archivo añadido, borrado o renombrado',
        mode: 'Cambió el modo del archivo',
        notText: 'No es texto plano',
        frontmatter: 'Frontmatter cambiado',
        locked: 'Bloque bloqueado tocado',
        secret: 'Parece un secreto',
        personalPath: 'Ruta personal',
        personalData: 'Datos personales (un correo, tu nombre o un proyecto tuyo)',
        profileText: 'Texto de tu perfil',
        lessonText: 'Texto de tus lecciones',
        noChanges: 'No cambió nada',
        unexplained: 'Sin justificación',
      })[kind] ?? kind,
    proposalTests: 'Build, lint y tests',
    testStep: (name: string, ok: boolean, seconds: number) => `${name}: ${ok ? 'correcto' : 'fallido'} (${seconds} s)`,
    proposalNotTested: 'No se ejecutaron: antes deben pasar las comprobaciones del cambio.',
    safetyFlaggedTitle: 'Aviso de seguridad: este cambio puede debilitar una regla',
    safetyFlaggedNote: (model: string) =>
      `Un modelo barato (${model}) leyó el diff y lo indica. No impide aprobar: lee los cambios de abajo antes de decidir.`,
    safetyClear: (model: string) => `Revisión de seguridad (${model}): no encontró ninguna regla de seguridad, permisos, escritura o preguntas en texto debilitada.`,
    safetyUnavailable: (reason: string) => `Revisión de seguridad: sin respuesta (${reason}). Lee el diff teniéndolo en cuenta.`,
    proposalRounds: 'Rondas',
    roundLine: (n: number, outcome: string | undefined, denials: number) =>
      `Ronda ${n}: ${outcome === 'submitted' ? 'propuesta entregada' : outcome === 'noProposal' ? 'sin propuesta' : outcome === 'failed' ? 'fallida' : outcome === 'interrupted' ? 'interrumpida' : 'en marcha'}${denials > 0 ? `, ${denials} llamada(s) denegada(s) por el guardián` : ''}.`,
    roundFeedback: 'Pediste:',
    proposalPreparing: 'La sesión de mejora está en marcha. Esta página se actualiza sola.',
    proposalVerifying: 'El servidor está comprobando y probando el cambio.',
    proposalWaiting: (blockers: string) => `Aprobada. Se aplica en cuanto no haya ninguna creación en marcha (ahora: ${blockers}).`,
    proposalRevertWaitingText: (blockers: string) => `La reversión se hace en cuanto no haya ninguna creación en marcha (ahora: ${blockers}).`,
    proposalApplied: (commit: string) => `Aplicada como commit ${commit} en tu rama. No se ha hecho push.`,
    proposalReverted: (commit: string) => `Revertida con el commit ${commit}.`,
    proposalDiscarded: 'Descartada: se borraron su rama y su worktree.',
    proposalApprove: 'Aprobar y aplicar',
    proposalApproveTitle: '¿Aplicar esta mejora?',
    proposalApproveBody: 'Se convierte en un commit en tu rama (sin push). Si hay una creación en marcha, espera a que no haya ninguna.',
    proposalAskChanges: 'Pedir cambios',
    proposalChangesLabel: '¿Qué debería ser distinto?',
    proposalSendChanges: 'Empezar otra ronda',
    proposalDiscard: 'Descartar',
    proposalDiscardTitle: '¿Descartar esta propuesta?',
    proposalDiscardBody: 'Se borran su rama y su worktree. No cambia nada en tu repositorio.',
    proposalRevert: 'Revertir',
    proposalRevertTitle: '¿Revertir esta mejora?',
    proposalRevertBody: 'Un commit de reversión deshace sus cambios y mantiene los posteriores. Si hay una creación en marcha, espera a que no haya ninguna.',
    proposalCheck: 'Ejecutar la comprobación real',
    proposalCheckTitle: (name: string) => `Comprobación real: ${name}`,
    realCheckState: (state: string) => ({ running: 'En marcha…', passed: 'Correcta', failed: 'Fallida' })[state] ?? state,
    cardPrepareImprovement: (model: string) =>
      `Preparar una mejora del flujo de creación de briefstack. Se ejecuta una sesión de mejora con ${model} que consume parte de tu plan; revisas y apruebas el resultado en su página:`,
    cardEvidence: (sessions: number, lessons: boolean, suggestion: boolean) =>
      `Evidencia: ${[sessions > 0 ? `${sessions} sesión(es)` : '', lessons ? 'la nota de lecciones' : '', suggestion ? 'una sugerencia' : ''].filter(Boolean).join(', ') || 'ninguna'}.`,
    chatNoticeSuggestions: 'Ha terminado una creación. Sugerencias para mejorar el flujo:',
    creationSuggestions: 'Qué se podría mejorar',
    errImproveBusy: 'Ya hay una sesión de mejora en marcha. Espera a que termine.',
    errImproveConflict: (file: string) => `${file} cambió desde que se preparó la propuesta, en las mismas líneas. Pide cambios para preparar otra ronda.`,
    errImproveBaseChanged: (file: string, branch: string) => `${file} cambió en ${branch} desde que se preparó la propuesta. Pide cambios: la ronda nueva parte del ${branch} actual y se comprueba y prueba otra vez.`,
    errImproveStaleReview: 'Esta propuesta se volvió a comprobar desde que esta página la mostró. Recarga, revisa la ronda nueva y aprueba esa.',
    errImproveUncommitted: (file: string) => `${file} tiene cambios sin commit en la parte que cambia la propuesta. Haz commit o descártalos antes.`,
    errImproveNotOnBranch: (branch: string) => `Tu repositorio no está en ${branch}, donde se preparó la propuesta. Vuelve a esa rama e inténtalo de nuevo.`,
    errImproveMoved: 'La rama se movió mientras se aplicaba el cambio. No cambió nada; inténtalo de nuevo.',
    errImproveNoRepo: 'El repositorio de briefstack no puede recibir una mejora ahora (debe ser un repositorio git en una rama, fuera del home de briefstack).',
    errImproveWrongState: 'La propuesta no puede hacer eso en su estado actual. Recarga la página.',
  },
});

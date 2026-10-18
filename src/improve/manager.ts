import os from 'node:os';
import { isPathInside, type PathEnv } from '../config/index.js';
import { redactDeep } from '../chat/tools.js';
import { BriefstackError } from '../errors.js';
import { listNotes, readNote } from '../library/index.js';
import { classifyAsset } from './allowlist.js';
import { writeEvidence, type EvidenceChoice } from './evidence.js';
import { prepareContext, type PreparedContext } from './filters.js';
import { applyChanges, commitWorktree, createWorktree, currentBranch, ignoredFiles, moveWorktree, removeWorktree, revertChangesOf, revParse, untrackedFiles, type ApplyResult, type BodyChange } from './git.js';
import { writeImproveRulesSync } from './guardCommand.js';
import type { ProposalRecord, ProposalStatus, ProposalSummary, ProposalView, Round } from './proposal.js';
import { offeredCheck, type RealCheckRunner } from './realCheck.js';
import { ImproveStore, newProposalId } from './store.js';
import { suggestionText, type Suggestion, type SuggestionStore } from './suggestions.js';
import { SUBMIT_PROPOSAL_TOOL } from './toolNames.js';
import type { ImprovementRunner, ImproveRunHandle, ImproveRunOutcome } from './types.js';
import { validateRound } from './validate.js';
import type { Verifier } from './verify.js';

/**
 * Improvements from the request to the commit (BRIEF-phase-5 §3.2–§3.4).
 *
 * - One improvement session at a time (`improve.busy`).
 * - After the session the server commits the worktree on the branch,
 *   validates the round, and only then runs build, lint and tests.
 * - Approve and revert never run while a creation is active: they wait
 *   (`waiting`, `revertWaiting`) and run as soon as none is, checked every
 *   `gatePollMs`.
 * - Git work, saving and status changes run one after another.
 */

export interface ImproveLocations {
  home: string;
  libraryDir: string;
  projectsDir: string;
  sessionsDir: string;
}

export interface ImprovementManagerOptions {
  store: ImproveStore;
  /** The briefstack repo the improvement applies to. */
  repoDir: string;
  runner: ImprovementRunner;
  verifier: Verifier;
  realChecks?: RealCheckRunner;
  pathEnv: PathEnv;
  locations: () => Promise<ImproveLocations>;
  /** The model and effort of an improvement session. */
  profile: () => Promise<{ model: string; effort?: string }>;
  /** What is running now that blocks applying: creations (their ideas or session ids). Empty when nothing is. */
  blockers: () => Promise<string[]>;
  /**
   * Runs a task while no creation may start (`CreationManager.holdStarts`).
   * Applying and reverting check `blockers` and commit inside it, so a
   * creation cannot start between the check and the commit.
   */
  holdStarts?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Turns a creation ended in text, by session id (not in `events.jsonl`). */
  textTurns?: (sessionId: string) => number | undefined;
  /** Suggestions after creations: listed, used as evidence, marked once prepared. */
  suggestions?: SuggestionStore;
  now?: () => Date;
  /** How often waiting approvals check for running creations. Default 2 s. */
  gatePollMs?: number;
}

const OPEN_STATES: readonly ProposalStatus[] = ['ready', 'rejected', 'failed'];
const MAX_DENIALS = 50;

export class ImprovementManager {
  private active: { id: string; handle: ImproveRunHandle } | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private gateTimer: NodeJS.Timeout | undefined;
  private readonly checking = new Set<string>();
  private closed = false;
  private readonly now: () => Date;

  private constructor(private readonly options: ImprovementManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Opens the manager: proposals a stopped server left mid-session are marked failed; waiting ones keep waiting. */
  static async open(options: ImprovementManagerOptions): Promise<ImprovementManager> {
    const manager = new ImprovementManager(options);
    for (const record of await options.store.list()) {
      if (record.status === 'preparing' || record.status === 'verifying') {
        const round = record.rounds.at(-1);
        if (round !== undefined && round.endedAt === undefined) {
          round.endedAt = manager.stamp();
          round.outcome = 'interrupted';
        }
        record.status = 'failed';
        record.error = 'The server stopped while this proposal was being prepared. Ask for changes to run the round again, or discard it.';
        await manager.save(record);
      }
    }
    manager.armGate();
    return manager;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private redact(text: string): string {
    return redactDeep(text, this.options.pathEnv.homedir) as string;
  }

  private async save(record: ProposalRecord): Promise<void> {
    record.updatedAt = this.stamp();
    await this.options.store.save(record);
  }

  /** Runs `task` after every earlier one, so git work and saves never overlap. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async find(id: string): Promise<ProposalRecord> {
    const record = await this.options.store.load(id);
    if (record === undefined) throw new BriefstackError('improve.notFound', { id });
    return record;
  }

  // ---- Reading -------------------------------------------------------------

  /** The model and effort an improvement session would run with now. */
  sessionProfile(): Promise<{ model: string; effort?: string }> {
    return this.options.profile();
  }

  /** The running session's proposal id, if any. */
  activeId(): string | undefined {
    return this.active?.id;
  }

  async list(): Promise<ProposalSummary[]> {
    return (await this.options.store.list()).map(summaryOf);
  }

  async get(id: string): Promise<ProposalView> {
    return viewOf(await this.find(id));
  }

  /** Suggestions after creations, newest first. */
  async suggestions(): Promise<Suggestion[]> {
    return (await this.options.suggestions?.list()) ?? [];
  }

  /** What blocks applying now (running creations), for the page. */
  blockers(): Promise<string[]> {
    return this.options.blockers();
  }

  // ---- Preparing -----------------------------------------------------------

  /** Starts an improvement session for `request` with the chosen evidence. */
  async prepare(request: string, choice: EvidenceChoice & { suggestionId?: string } = {}): Promise<ProposalView> {
    return this.serial(async () => {
      if (this.active !== undefined) throw new BriefstackError('improve.busy', { id: this.active.id });
      const { repoDir, store } = this.options;
      const branch = await currentBranch(repoDir).catch(() => undefined);
      if (branch === undefined) throw new BriefstackError('improve.noRepo', { reason: 'it is not a git repository on a branch (HEAD is detached or git is missing).' });
      if (isPathInside(store.root, repoDir, this.options.pathEnv) || isPathInside(repoDir, store.root, this.options.pathEnv)) {
        throw new BriefstackError('improve.noRepo', { reason: 'the briefstack home is inside the repository; worktrees must be outside it.' });
      }
      const baseCommit = await revParse(repoDir, 'HEAD');
      const id = newProposalId(this.now());
      const worktreeDir = store.worktreeDir(id);
      const record: ProposalRecord = {
        v: 1,
        id,
        createdAt: this.stamp(),
        updatedAt: this.stamp(),
        status: 'preparing',
        request: this.redact(request.trim()),
        ...(choice.suggestionId === undefined ? {} : { suggestionId: choice.suggestionId }),
        evidence: [],
        baseBranch: branch,
        baseCommit,
        branch: `improve/${id}`,
        worktreeDir,
        rounds: [],
        files: [],
      };
      await createWorktree(repoDir, worktreeDir, record.branch, baseCommit);
      const locations = await this.options.locations();
      const found = choice.suggestionId === undefined ? undefined : await this.options.suggestions?.get(choice.suggestionId);
      if (choice.suggestionId !== undefined && found === undefined) {
        await removeWorktree(repoDir, worktreeDir, record.branch).catch(() => undefined);
        throw new BriefstackError('improve.suggestionNotFound', { id: choice.suggestionId });
      }
      const suggestion = found === undefined ? undefined : { id: found.id, text: suggestionText(found), signals: found };
      record.evidence = await writeEvidence({
        dir: store.evidenceDir(id),
        request,
        choice: { ...choice, ...(suggestion === undefined ? {} : { suggestion }) },
        sessionsDir: locations.sessionsDir,
        libraryDir: locations.libraryDir,
        homedir: this.options.pathEnv.homedir,
        ...(this.options.textTurns === undefined ? {} : { textTurns: this.options.textTurns }),
      });
      writeImproveRulesSync(store.rulesFile(id), { v: 1, worktree: worktreeDir, evidence: [store.evidenceDir(id)], submitTool: SUBMIT_PROPOSAL_TOOL });
      await this.startRound(record, undefined);
      if (found !== undefined) await this.options.suggestions?.markUsed(found.id, id).catch(() => undefined);
      return viewOf(record);
    });
  }

  /**
   * "Ask for changes": a new round on the same branch, with the user's text.
   * If the branch the proposal applies to moved, the worktree first moves to
   * its tip (`moveWorktree`) and that tip becomes the base, so the round is
   * validated and tested against what approving would change.
   */
  async askChanges(id: string, feedback: string): Promise<ProposalView> {
    return this.serial(async () => {
      if (this.active !== undefined) throw new BriefstackError('improve.busy', { id: this.active.id });
      const record = await this.find(id);
      if (!OPEN_STATES.includes(record.status)) throw new BriefstackError('improve.wrongState', { id, status: record.status });
      delete record.error;
      let notice: string | undefined;
      const tip = await revParse(this.options.repoDir, `refs/heads/${record.baseBranch}`).catch(() => undefined);
      if (tip !== undefined && tip !== record.baseCommit) {
        const files = record.files.flatMap((file) => (file.base === undefined || file.proposed === undefined ? [] : [{ path: file.path, base: file.base, proposed: file.proposed }]));
        const { dropped } = await moveWorktree(record.worktreeDir, tip, files);
        record.baseCommit = tip;
        notice =
          dropped.length === 0
            ? 'the branch moved since the last round; the worktree now starts from its current tip, with your earlier changes merged onto it.'
            : `the branch moved since the last round; the worktree now starts from its current tip. Your earlier changes to ${dropped.join(', ')} no longer applied and were dropped: redo them if they are still needed.`;
      }
      await this.startRound(record, this.redact(feedback.trim()), notice);
      return viewOf(record);
    });
  }

  private async startRound(record: ProposalRecord, feedback: string | undefined, notice?: string): Promise<void> {
    const n = record.rounds.length + 1;
    const round: Round = { n, startedAt: this.stamp(), denials: [], ...(feedback === undefined ? {} : { feedback }) };
    record.rounds.push(round);
    record.status = 'preparing';
    await this.save(record);
    const profile = await this.options.profile();
    const { store } = this.options;
    const handle = this.options.runner.start({
      proposalId: record.id,
      round: n,
      worktreeDir: record.worktreeDir,
      evidenceDir: store.evidenceDir(record.id),
      rulesFile: store.rulesFile(record.id),
      request: record.request,
      ...(feedback === undefined ? {} : { feedback }),
      ...(notice === undefined ? {} : { notice }),
      model: profile.model,
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      emit: (event) => {
        if (event.kind === 'denial' && round.denials.length < MAX_DENIALS) round.denials.push({ tool: event.tool, reason: this.redact(event.reason) });
        if (event.kind === 'text') round.text = this.redact(event.text).slice(0, 4000);
      },
    });
    this.active = { id: record.id, handle };
    void handle.done
      .catch((error: unknown): ImproveRunOutcome => ({ kind: 'failed', error: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => this.serial(() => this.finishRound(record.id, round, outcome)))
      .catch(() => undefined);
  }

  private async finishRound(id: string, live: Round, outcome: ImproveRunOutcome): Promise<void> {
    if (this.active?.id === id) this.active = undefined;
    const record = await this.find(id);
    const round = record.rounds.find((r) => r.n === live.n) ?? live;
    Object.assign(round, { denials: live.denials, ...(live.text === undefined ? {} : { text: live.text }), endedAt: this.stamp() });
    if (outcome.kind !== 'ended') {
      round.outcome = outcome.kind === 'stopped' ? 'interrupted' : 'failed';
      if (outcome.kind === 'failed') round.error = this.redact(outcome.error).slice(0, 1000);
      record.status = 'failed';
      record.error = outcome.kind === 'stopped' ? 'The session was stopped before it finished.' : `The session failed: ${round.error ?? ''}`;
      await this.save(record);
      return;
    }
    round.outcome = outcome.submission === undefined ? 'noProposal' : 'submitted';
    if (outcome.submission !== undefined) {
      record.title = this.redact(outcome.submission.title);
      record.expectedEffect = this.redact(outcome.submission.expectedEffect);
    }
    record.status = 'verifying';
    await this.save(record);
    try {
      // Listed before the commit: afterwards new files are in it, and ignored ones are not seen at all.
      const stray = { untracked: await untrackedFiles(record.worktreeDir), ignored: await ignoredFiles(record.worktreeDir) };
      const commit = await commitWorktree(record.worktreeDir, `Improvement ${id}, round ${round.n}`);
      if (commit !== undefined) round.commit = commit;
      const head = await revParse(record.worktreeDir, 'HEAD');
      const check = await validateRound({
        repoDir: this.options.repoDir,
        baseCommit: record.baseCommit,
        head,
        stray,
        submission: outcome.submission === undefined ? undefined : redactDeep(outcome.submission, this.options.pathEnv.homedir) as typeof outcome.submission,
        context: await this.personalContext(),
      });
      record.files = check.files;
      record.validation = { ok: check.problems.length === 0, problems: check.problems };
      delete record.checks;
      delete record.realCheck;
      if (check.problems.length > 0) {
        record.status = 'rejected';
      } else {
        record.checks = await this.options.verifier.verify(record.worktreeDir);
        record.status = record.checks.ok ? 'ready' : 'failed';
        if (!record.checks.ok) record.error = record.checks.error ?? 'Build, lint or tests failed in the worktree.';
      }
    } catch (error) {
      record.status = 'failed';
      record.error = this.redact(`Checking the round failed: ${error instanceof Error ? error.message : String(error)}`).slice(0, 1000);
    }
    await this.save(record);
  }

  private async personalContext(): Promise<PreparedContext> {
    const locations = await this.options.locations();
    const profileTexts: string[] = [];
    for (const note of await listNotes(locations.libraryDir, 'profile').catch(() => [])) {
      try {
        profileTexts.push((await readNote(locations.libraryDir, 'profile', note.name)).text);
      } catch {
        // Unreadable notes add nothing.
      }
    }
    let username: string | undefined;
    try {
      username = os.userInfo().username;
    } catch {
      username = undefined;
    }
    return prepareContext({
      homedir: this.options.pathEnv.homedir,
      username,
      folders: [locations.home, locations.libraryDir, locations.projectsDir, locations.sessionsDir, this.options.repoDir],
      profileTexts,
    });
  }

  // ---- Discard, approve, revert ---------------------------------------------

  async discard(id: string): Promise<ProposalView> {
    if (this.active?.id === id) await this.active.handle.stop();
    return this.serial(async () => {
      const record = await this.find(id);
      if (!['preparing', ...OPEN_STATES, 'waiting'].includes(record.status)) throw new BriefstackError('improve.wrongState', { id, status: record.status });
      await removeWorktree(this.options.repoDir, record.worktreeDir, record.branch);
      record.status = 'discarded';
      delete record.error;
      await this.save(record);
      return viewOf(record);
    });
  }

  /** Approve: applied now, or `waiting` while a creation runs. A refusal leaves it `ready` and throws. */
  async approve(id: string): Promise<ProposalView> {
    const record = await this.serial(async () => {
      const found = await this.find(id);
      if (found.status !== 'ready') throw new BriefstackError('improve.wrongState', { id, status: found.status });
      if (found.validation?.ok !== true || found.checks?.ok !== true) throw new BriefstackError('improve.wrongState', { id, status: found.status });
      found.status = 'waiting';
      delete found.error;
      await this.save(found);
      return found;
    });
    return this.runGated(record.id, 'waiting');
  }

  /** Revert: a revert commit now, or `revertWaiting` while a creation runs. */
  async revert(id: string): Promise<ProposalView> {
    const record = await this.serial(async () => {
      const found = await this.find(id);
      if (found.status !== 'applied') throw new BriefstackError('improve.wrongState', { id, status: found.status });
      found.status = 'revertWaiting';
      delete found.error;
      await this.save(found);
      return found;
    });
    return this.runGated(record.id, 'revertWaiting');
  }

  /** Runs a waiting apply or revert if nothing blocks it; otherwise leaves it waiting. */
  private async runGated(id: string, state: 'waiting' | 'revertWaiting'): Promise<ProposalView> {
    const hold = this.options.holdStarts ?? (<T>(task: () => Promise<T>) => task());
    const outcome = await this.serial(async () => {
      const record = await this.find(id);
      if (record.status !== state) return { record };
      // Inside the hold: a creation that started before it is a blocker, and none starts until the commit is made.
      return hold(async (): Promise<{ record: ProposalRecord; error?: BriefstackError | undefined }> => {
        if ((await this.options.blockers()).length > 0) {
          this.armGate();
          return { record };
        }
        const error = state === 'waiting' ? await this.doApply(record) : await this.doRevert(record);
        await this.save(record);
        return { record, error };
      });
    });
    if (outcome.error !== undefined) throw outcome.error;
    return viewOf(outcome.record);
  }

  private refusal(result: Exclude<ApplyResult, { ok: true }>, branch: string): BriefstackError {
    switch (result.reason) {
      case 'wrongBranch':
        return new BriefstackError('improve.notOnBranch', { branch, current: result.current ?? 'a detached HEAD' });
      case 'uncommitted':
        return new BriefstackError('improve.uncommitted', { file: result.path });
      case 'missing':
      case 'conflict':
        return new BriefstackError('improve.conflict', { file: result.path });
      case 'baseChanged':
        return new BriefstackError('improve.baseChanged', { file: result.path, branch });
      case 'moved':
        return new BriefstackError('improve.moved', {});
    }
  }

  private changesOf(record: ProposalRecord): BodyChange[] {
    return record.files.flatMap((file) =>
      file.base === undefined || file.proposed === undefined
        ? []
        : [{ path: file.path, bodyOnly: classifyAsset(file.path)?.bodyOnly ?? false, base: file.base, proposed: file.proposed }],
    );
  }

  private async doApply(record: ProposalRecord): Promise<BriefstackError | undefined> {
    const title = record.title ?? 'improvement';
    const message = `Apply improvement ${record.id}: ${title}\n\n${record.expectedEffect ?? ''}\n\nBriefstack-Improvement: ${record.id}\n`;
    const result = await applyChanges(this.options.repoDir, record.baseBranch, this.changesOf(record), message, { strict: true });
    if (!result.ok) {
      const error = this.refusal(result, record.baseBranch);
      record.status = 'ready';
      record.error = this.redact(error.message);
      return error;
    }
    record.status = 'applied';
    record.appliedCommit = result.commit;
    record.appliedAt = this.stamp();
    // The commit holds the change; the worktree and branch are no longer needed.
    await removeWorktree(this.options.repoDir, record.worktreeDir, record.branch).catch(() => undefined);
    return undefined;
  }

  private async doRevert(record: ProposalRecord): Promise<BriefstackError | undefined> {
    const commit = record.appliedCommit as string;
    const files = record.files.flatMap((file) => (file.base === undefined ? [] : [{ path: file.path, bodyOnly: classifyAsset(file.path)?.bodyOnly ?? false }]));
    const changes = await revertChangesOf(this.options.repoDir, commit, files);
    const message = `Revert improvement ${record.id}: ${record.title ?? 'improvement'}\n\nThis reverts the body changes of commit ${commit}.\n\nBriefstack-Improvement: ${record.id}\n`;
    const result = await applyChanges(this.options.repoDir, record.baseBranch, changes, message);
    if (!result.ok) {
      const error = this.refusal(result, record.baseBranch);
      record.status = 'applied';
      record.error = this.redact(error.message);
      return error;
    }
    record.status = 'reverted';
    record.revertCommit = result.commit;
    record.revertedAt = this.stamp();
    return undefined;
  }

  /** While something waits, checks every `gatePollMs` whether it can run. */
  private armGate(): void {
    if (this.closed || this.gateTimer !== undefined) return;
    this.gateTimer = setTimeout(() => {
      this.gateTimer = undefined;
      void this.drainWaiting();
    }, this.options.gatePollMs ?? 2000);
    this.gateTimer.unref();
  }

  /** Runs every waiting apply and revert, oldest first, once nothing blocks them. */
  async drainWaiting(): Promise<void> {
    const waiting = (await this.options.store.list()).filter((r) => r.status === 'waiting' || r.status === 'revertWaiting').reverse();
    for (const record of waiting) {
      try {
        await this.runGated(record.id, record.status as 'waiting' | 'revertWaiting');
      } catch {
        // The refusal is on the record; the page shows it.
      }
    }
    if ((await this.options.store.list()).some((r) => r.status === 'waiting' || r.status === 'revertWaiting')) this.armGate();
  }

  // ---- Real check ------------------------------------------------------------

  /** Starts the proposal's real check; its result is added to the proposal when it ends. */
  async startCheck(id: string): Promise<ProposalView> {
    const record = await this.serial(async () => {
      const found = await this.find(id);
      if (found.status !== 'ready') throw new BriefstackError('improve.wrongState', { id, status: found.status });
      const name = offeredCheck(found.files);
      if (name === undefined || this.options.realChecks === undefined) throw new BriefstackError('improve.noCheck', { id });
      if (this.checking.has(id)) throw new BriefstackError('improve.checkBusy', { id });
      this.checking.add(id);
      found.realCheck = { name, state: 'running', startedAt: this.stamp() };
      await this.save(found);
      return found;
    });
    const name = record.realCheck?.name ?? 'improvement-flow';
    void (this.options.realChecks as RealCheckRunner)
      .run(name, record.worktreeDir)
      .catch((error: unknown) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }))
      .then((result) =>
        this.serial(async () => {
          this.checking.delete(id);
          const latest = await this.find(id);
          latest.realCheck = { name, state: result.ok ? 'passed' : 'failed', startedAt: record.realCheck?.startedAt ?? this.stamp(), endedAt: this.stamp(), output: this.redact(result.output) };
          await this.save(latest);
        }),
      )
      .catch(() => undefined);
    return viewOf(record);
  }

  /** Stops the running session; the next open marks its proposal failed. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.gateTimer !== undefined) clearTimeout(this.gateTimer);
    await this.active?.handle.stop();
    await this.chain.catch(() => undefined);
  }
}

export function viewOf(record: ProposalRecord): ProposalView {
  const rest: Partial<ProposalRecord> = { ...record };
  delete rest.worktreeDir;
  delete rest.v;
  const offered = record.status === 'ready' ? offeredCheck(record.files) : undefined;
  return { ...(rest as Omit<ProposalRecord, 'worktreeDir' | 'v'>), ...(offered === undefined ? {} : { offeredCheck: offered }) };
}

export function summaryOf(record: ProposalRecord): ProposalSummary {
  return {
    id: record.id,
    status: record.status,
    ...(record.title === undefined ? {} : { title: record.title }),
    request: record.request.slice(0, 300),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    files: record.files.map((file) => file.path),
    ...(record.appliedCommit === undefined ? {} : { appliedCommit: record.appliedCommit }),
    ...(record.revertCommit === undefined ? {} : { revertCommit: record.revertCommit }),
  };
}

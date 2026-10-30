import type { TaskErrorFacts, uiMessages } from '../i18n/ui.js';
import { ApiError } from './apiError.js';

type Messages = (typeof uiMessages)['en'];

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

const TASK_STATES = new Set(['running', 'checking', 'proposal', 'applied', 'reverted', 'discarded', 'failed', 'cancelled', 'interrupted']);
/** A branch name as git allows it, short: anything else is not shown. */
const BRANCH_RE = /^[\w./-]{1,100}$/;

/**
 * What a task error may show (phase 7): a known state, numbers, branch
 * names, and at most ten project-relative paths of uncommitted files (the
 * project page lists them already). No command, folder or free text.
 */
function taskFacts(params: Readonly<Record<string, unknown>>, t: Messages): TaskErrorFacts {
  const text = (value: unknown, re: RegExp) => (typeof value === 'string' && re.test(value) ? value : '?');
  const paths = Array.isArray(params.paths)
    ? params.paths.filter((item): item is string => typeof item === 'string' && item.length <= 200 && !/^([a-zA-Z]:)?[\\/]/.test(item)).slice(0, 10)
    : [];
  return {
    state: typeof params.state === 'string' && TASK_STATES.has(params.state) ? t.taskState(params.state) : '?',
    limit: typeof params.limit === 'number' ? params.limit : 0,
    active: Array.isArray(params.active) ? params.active.length : 0,
    branch: text(params.branch, BRANCH_RE),
    current: text(params.current, BRANCH_RE),
    paths,
    items: Array.isArray(params.items) ? params.items.length : 0,
    required: text(params.required, /^\d+(\.\d+)*$/),
  };
}

/**
 * The UI's own text for an error. The server's message is never shown, and no
 * parameter other than line numbers and a folder kind is used, so a secret
 * cannot reach the page through an error.
 */
export function describeError(error: unknown, t: Messages): string {
  if (!(error instanceof ApiError)) return t.errGeneric('unknown');
  switch (error.code) {
    case 'web.rejected.token':
      return t.restarted;
    case 'library.secretContent': {
      const lines = numbers(error.params.lines);
      return lines.length === 0 ? t.errSecretNoLines : t.errSecret(lines);
    }
    case 'config.relativePath':
      return t.errRelativePath;
    case 'scaffold.forbiddenOutput':
      return t.errForbiddenOutput(String(error.params.root));
    case 'scaffold.notADirectory':
      return t.errNotADirectory;
    case 'library.noteNotFound':
      return t.errNoteNotFound;
    case 'library.commitNotFound':
      return t.errCommitNotFound;
    case 'library.dirtyTree':
      return t.errDirtyTree;
    case 'library.revertConflict':
      return t.errRevertConflict;
    case 'usage.unknownProfile':
      return t.errUnknownProfile;
    case 'web.invalidBody':
      return t.errInvalidBody;
    case 'creation.invalidAnswer':
      return t.errInvalidAnswer;
    case 'creation.noReply':
      return t.errNoReply;
    case 'creation.limit':
      return t.limitMessage;
    case 'library.busy':
      return t.errLibraryBusy;
    case 'improve.busy':
      return t.errImproveBusy;
    case 'improve.conflict':
      return t.errImproveConflict(String(error.params.file));
    case 'improve.baseChanged':
      return t.errImproveBaseChanged(String(error.params.file), String(error.params.branch));
    case 'improve.staleReview':
      return t.errImproveStaleReview;
    case 'improve.uncommitted':
      return t.errImproveUncommitted(String(error.params.file));
    case 'improve.notOnBranch':
      return t.errImproveNotOnBranch(String(error.params.branch));
    case 'improve.moved':
      return t.errImproveMoved;
    case 'improve.noRepo':
      return t.errImproveNoRepo;
    case 'improve.wrongState':
      return t.errImproveWrongState;
    case 'skills.invalidUrl':
      return t.errSkillUrl(String(error.params.reason));
    case 'skills.repoNotFound':
      return t.errSkillRepoNotFound;
    case 'skills.refNotFound':
      return t.errSkillRefNotFound;
    case 'skills.pathNotFound':
      return t.errSkillPathNotFound;
    case 'skills.noSkillFile':
      return t.errSkillNoSkillFile;
    case 'skills.rateLimited':
      return t.errSkillRateLimited;
    case 'skills.network':
      return t.errSkillNetwork;
    case 'skills.tooLarge':
      return t.errSkillTooLarge;
    case 'skills.pathTooLong':
      return t.errSkillPathTooLong(Number(error.params.limit));
    case 'skills.forbiddenEntry':
      return t.errSkillForbidden;
    case 'skills.integrity':
      return t.errSkillIntegrity;
    case 'skills.exists':
      return t.errSkillExists(error.params.sameSource === true);
    case 'skills.invalidName':
      return t.errSkillInvalidName;
    case 'skills.invalidTag':
      return t.errSkillInvalidTag;
    case 'skills.modified':
      return t.errSkillModified;
    case 'skills.wrongStatus':
      return t.errSkillWrongStatus;
    case 'skills.updatePending':
      return t.errSkillUpdatePending;
    case 'skills.notApproved':
      return t.errSkillNotApproved;
    case 'usage.high':
      return t.usageWarnBody(
        typeof error.params.fiveHour === 'number' ? error.params.fiveHour : null,
        Number(error.params.warnFiveHour),
        typeof error.params.sevenDay === 'number' ? error.params.sevenDay : null,
        Number(error.params.warnWeek),
      );
    default:
      return (error.code.startsWith('task.') ? t.errTask(error.code, taskFacts(error.params, t)) : undefined) ?? t.errGeneric(error.code);
  }
}

import type { uiMessages } from '../i18n/ui.js';
import { ApiError } from './apiError.js';

type Messages = (typeof uiMessages)['en'];

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
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
      return t.errGeneric(error.code);
  }
}

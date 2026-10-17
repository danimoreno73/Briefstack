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
    default:
      return t.errGeneric(error.code);
  }
}

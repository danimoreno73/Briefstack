export * from './context.js';
export { FALLBACK_IDENTITY, gitCommit, gitInit, isGitRepo, type GitWarning } from './git.js';
export * from './indexFile.js';
export * from './init.js';
export * from './layout.js';
export {
  addNote,
  appendDated,
  appendText,
  datedEntries,
  datedEntryHeading,
  DATED_ENTRY_RE,
  libraryExists,
  listNotes,
  noteRef,
  readNote,
  secretLines,
  summaryFromBody,
  type AddNoteOptions,
  type AddNoteResult,
  type NoteRef,
  type NoteSummary,
} from './notes.js';
export * from './projectStatus.js';
export * from './settings.js';

export * from './context.js';
export {
  FALLBACK_IDENTITY,
  gitCommit,
  gitFirstAddedDate,
  gitHasChanges,
  gitInit,
  isGitRepo,
  type GitWarning,
} from './git.js';
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
  saveNote,
  secretLines,
  summaryFromBody,
  type AddNoteOptions,
  type AddNoteResult,
  type NoteRef,
  type NoteSummary,
  type SaveMode,
  type SaveNoteOptions,
  type SaveNoteResult,
} from './notes.js';
export * from './projects.js';
export * from './projectStatus.js';
export * from './settings.js';

/**
 * An idea handed to the New project page by "Start again with this idea".
 * Kept in memory for the next visit to that page only: no route or storage
 * changes, and a reload starts with an empty box.
 */
let draft: string | undefined;

export function setIdeaDraft(idea: string): void {
  draft = idea;
}

/** The idea left for the New project page, once; `undefined` when there is none. */
export function takeIdeaDraft(): string | undefined {
  const idea = draft;
  draft = undefined;
  return idea;
}

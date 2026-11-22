/**
 * Facts a command learns while it reads the repository that its output must carry, though the command never asks
 * for them: how well C and C++ includes resolved is known only inside the project loader. A loader records a note, and
 * `runCli` adds the note's `value` to the document under `key`, prints its `warning` on stderr and its `notice` after a
 * table. A note recorded twice under one key replaces the first, so loading a project twice reports it once.
 */
export interface RunNote {
  /** The key of the document's top level the value is added under. */
  key: string;
  value: unknown;
  /** A line for the notices after a table. */
  notice?: string;
  /** A line for stderr, printed whatever the output format. */
  warning?: string;
}

const notes = new Map<string, RunNote>();

export function recordRunNote(note: RunNote): void {
  notes.set(note.key, note);
}

/** Forgets the notes of an earlier run. Each CLI invocation starts from none. */
export function resetRunNotes(): void {
  notes.clear();
}

export function runNotes(): RunNote[] {
  return [...notes.values()];
}

/**
 * The slot protocol. A report is two steps. `--slots` prints the data the report will show and the judgement
 * slots an agent fills in. The agent writes a notes file holding the stamp and one entry per slot, and
 * `--notes` renders it. Every number on the page comes from the data, never from the notes.
 */

/** Version of the slots and notes documents. A breaking change to either bumps it. */
export const PROTOCOL_VERSION = 1;

export type Format = "html" | "md";

/** What a slot is about. The `ref` is a path, a pair of paths, a symbol id, a finding id, or the report kind. */
export interface SlotSubject {
  kind: "file" | "pair" | "unit" | "finding" | "report";
  ref: string;
  /** How the page names the subject. */
  label: string;
}

/** One of the subjects a choosing slot allows. */
export interface Candidate {
  ref: string;
  label: string;
}

export interface Slot {
  id: string;
  /** The heading the judgement has on the page. */
  title: string;
  about: SlotSubject;
  /** What to write, in the words an agent follows. */
  task: string;
  /** The allowed verdicts. Empty when the slot takes text only. */
  verdicts: string[];
  /** The most characters of text one entry may hold. */
  maxChars: number;
  /**
   * A slot that asks for up to `max` subjects chosen from the data, each with its own verdict and text. Its entry
   * is `{ "items": [{ "subject": ref, ... }] }` with at least one and at most `max` items.
   */
  choose?: { max: number; candidates: Candidate[] };
}

/** What a stamp says a report was computed from. The notes must carry an equal one. */
export interface Stamp {
  protocol: number;
  kind: string;
  /** HEAD at the time of the run. */
  head: string;
  /** Hash of the effective config. */
  config: string;
  /** What else the data depends on: arguments, the window and the stored results it read. */
  inputs: Record<string, unknown>;
}

export interface NoteEntry {
  verdict?: string;
  text: string;
}

export interface ChoiceItem extends NoteEntry {
  subject: string;
}

export interface ChoiceEntry {
  items: ChoiceItem[];
}

export type SlotEntry = NoteEntry | ChoiceEntry;

/** The notes file an agent writes. */
export interface NotesDocument {
  stamp: Stamp;
  notes: Record<string, SlotEntry>;
}

/** What a rendering needs of the notes: the entries by slot id, after validation. */
export type Notes = Record<string, SlotEntry>;

export interface ExcludedCount {
  /** What was left out and why: "generated files", "commits over the changeset limit". */
  what: string;
  count: number;
}

/** The header of every report. The kit fills `repo`, `commit`, `date` and `configHash`; the report fills the rest. */
export interface ReportHeader {
  repo: string;
  commit: string;
  /** HEAD's committer date, as a date. The wall clock never appears in a report. */
  date: string;
  configHash: string;
  /** strong, moderate or weak, or "not applicable" for a report with no history behind it. */
  evidenceGrade: string;
  /** A sentence: the months of history read and the dates they run between. */
  historyWindow: string;
  /** Everything the report left out, with counts. Empty means nothing was left out. */
  excluded: ExcludedCount[];
}

/** A problem with the notes or the request, named so the person or agent can fix it. The kit turns it into exit code 2. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

import { folderOf } from "@code-health/graph/tree-distance";
import type { FixMatch } from "@code-health/history/fix-commits";
import type { MergedChange } from "./merged-changes.ts";

/** One revision of a file by a merged change. */
export interface Revision {
  time: number;
  authors: readonly string[];
  /** The fix this revision was, with the pattern that matched. Null when it was not a fix. */
  fix: FixMatch | null;
}

interface FileRecord {
  revisions: Revision[];
  /** False once the latest change to the file deleted it. */
  present: boolean;
  /** Ordinals of the eligible changes that touched the file, over all of history. */
  eligibleChanges: Set<number>;
}

interface Windowed {
  time: number;
  files: string[];
  eligible: boolean;
  fix: boolean;
}

/**
 * What the history looked like at a point in time. Changes are added oldest first, and a change is
 * scored before it is added, so the state a score reads can never contain the change itself or
 * anything after it. This is what keeps the backtest honest: scoring the past with later facts
 * would leak the outcome, since a file that was fixed later is a hotspot now.
 *
 * Windowed counts (revisions, coupling) cover the analysis window back from the last `advance`.
 * Per-file revision lists and "ever changed together" cover all of history so far.
 */
export class HistoryState {
  private readonly files = new Map<string, FileRecord>();
  private readonly queue: Windowed[] = [];
  private head = 0;
  private readonly windowRevisions = new Map<string, number>();
  private readonly eligibleRevisions = new Map<string, number>();
  private readonly pairs = new Map<string, Map<string, number>>();
  private readonly histogram = new Map<number, number>();
  private readonly identities = new Map<string, { first: number; last: number; changes: number }>();
  private readonly folders = new Map<string, Set<string>>();
  private ordinal = 0;
  private fixesInWindow = 0;
  private changesInWindow = 0;
  private eligibleInWindow = 0;

  private readonly options: { windowSeconds: number; maxChangesetSize: number };

  constructor(options: { windowSeconds: number; maxChangesetSize: number }) {
    this.options = options;
  }

  /** Moves the window to end at `now`, dropping what fell out of it. */
  advance(now: number): void {
    const since = now - this.options.windowSeconds;
    while (this.head < this.queue.length && this.queue[this.head]!.time < since) {
      this.evict(this.queue[this.head]!);
      this.head++;
    }
  }

  /** Adds a change. Call `advance(change.time)` first, and add changes oldest first. */
  add(change: MergedChange, fix: FixMatch | null): void {
    const ids = change.files.map((file) => file.fileId);
    const eligible = ids.length <= this.options.maxChangesetSize;
    const ordinal = this.ordinal++;
    for (const file of change.files) {
      const record = this.record(file.fileId);
      record.revisions.push({ time: change.time, authors: change.authors, fix });
      record.present = file.status !== "D";
      if (eligible) record.eligibleChanges.add(ordinal);
    }
    for (const author of change.authors) {
      const key = author.toLowerCase();
      const seen = this.identities.get(key);
      if (seen) {
        seen.last = change.time;
        seen.changes++;
      } else {
        this.identities.set(key, { first: change.time, last: change.time, changes: 1 });
      }
    }
    for (const id of ids) {
      const folder = folderOf(id);
      const inFolder = this.folders.get(folder);
      if (inFolder) inFolder.add(id);
      else this.folders.set(folder, new Set([id]));
    }
    const entry: Windowed = { time: change.time, files: ids, eligible, fix: fix !== null };
    this.queue.push(entry);
    this.apply(entry, 1);
  }

  private record(id: string): FileRecord {
    let record = this.files.get(id);
    if (!record) this.files.set(id, (record = { revisions: [], present: true, eligibleChanges: new Set() }));
    return record;
  }

  private evict(entry: Windowed): void {
    this.apply(entry, -1);
  }

  private apply(entry: Windowed, sign: 1 | -1): void {
    this.changesInWindow += sign;
    if (entry.fix) this.fixesInWindow += sign;
    for (const id of entry.files) this.bump(this.windowRevisions, id, sign, true);
    if (!entry.eligible) return;
    this.eligibleInWindow += sign;
    for (const [i, a] of entry.files.entries()) {
      this.bump(this.eligibleRevisions, a, sign, false);
      for (const b of entry.files.slice(i + 1)) {
        this.bumpPair(a, b, sign);
        this.bumpPair(b, a, sign);
      }
    }
  }

  private bump(counts: Map<string, number>, id: string, sign: 1 | -1, histogram: boolean): void {
    const before = counts.get(id) ?? 0;
    const after = before + sign;
    if (histogram) {
      if (before > 0) this.histogram.set(before, (this.histogram.get(before) ?? 1) - 1);
      if (after > 0) this.histogram.set(after, (this.histogram.get(after) ?? 0) + 1);
    }
    if (after === 0) counts.delete(id);
    else counts.set(id, after);
  }

  private bumpPair(a: string, b: string, sign: 1 | -1): void {
    let row = this.pairs.get(a);
    if (!row) this.pairs.set(a, (row = new Map()));
    const after = (row.get(b) ?? 0) + sign;
    if (after === 0) row.delete(b);
    else row.set(b, after);
  }

  /** When an identity (a lower-case mapped email) first and last changed anything, and in how many merged changes. Null if never. */
  identity(email: string): { first: number; last: number; changes: number } | null {
    return this.identities.get(email.toLowerCase()) ?? null;
  }

  /** Every file that has had a revision in the given folder (`""` is the root), whether or not it still exists. */
  filesInFolder(folder: string): ReadonlySet<string> {
    return this.folders.get(folder) ?? new Set();
  }

  /** Every file with a recorded revision, whether or not it still exists. */
  knownFiles(): Iterable<string> {
    return this.files.keys();
  }

  /** True when the file has any recorded revision. */
  known(id: string): boolean {
    return this.files.has(id);
  }

  /** False when the file is unknown or its latest change deleted it. */
  present(id: string): boolean {
    return this.files.get(id)?.present === true;
  }

  /** Revisions of the file at or after `since`, oldest first. */
  revisionsSince(id: string, since: number): Revision[] {
    const revisions = this.files.get(id)?.revisions ?? [];
    let start = revisions.length;
    while (start > 0 && revisions[start - 1]!.time >= since) start--;
    return revisions.slice(start);
  }

  /** Every revision of the file so far, oldest first. */
  revisionsOf(id: string): readonly Revision[] {
    return this.files.get(id)?.revisions ?? [];
  }

  lastChanged(id: string): number | null {
    return this.files.get(id)?.revisions.at(-1)?.time ?? null;
  }

  /** Revisions of the file within the window. */
  revisionsInWindow(id: string): number {
    return this.windowRevisions.get(id) ?? 0;
  }

  /** Eligible (not oversized) changes touching the file within the window. */
  eligibleRevisionsInWindow(id: string): number {
    return this.eligibleRevisions.get(id) ?? 0;
  }

  /** Eligible changes in the window that touched both files. */
  support(a: string, b: string): number {
    return this.pairs.get(a)?.get(b) ?? 0;
  }

  /** Every file that shared an eligible change with `id` in the window, with the count. */
  partners(id: string): ReadonlyMap<string, number> {
    return this.pairs.get(id) ?? new Map();
  }

  /** Whether the two files were ever in the same eligible change, in all of history so far. */
  everTogether(a: string, b: string): boolean {
    const left = this.files.get(a)?.eligibleChanges;
    const right = this.files.get(b)?.eligibleChanges;
    if (!left || !right) return false;
    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    for (const ordinal of small) if (large.has(ordinal)) return true;
    return false;
  }

  /**
   * The fewest revisions in the window that put a file in the top `topShare` of changed files, as
   * the hotspot ranking draws its line: the share of files strictly above must be below `topShare`.
   * Infinity when nothing changed in the window.
   */
  hotRevisionCount(topShare: number): number {
    const counts = [...this.histogram].filter(([, files]) => files > 0).sort((a, b) => b[0] - a[0]);
    const total = counts.reduce((sum, [, files]) => sum + files, 0);
    let above = 0;
    let line = Infinity;
    for (const [count, files] of counts) {
      if (above / total >= topShare) break;
      line = count;
      above += files;
    }
    return line;
  }

  /** Changes in the window, and how many of them were fixes. */
  windowSummary(): { changes: number; fixes: number; eligible: number } {
    return { changes: this.changesInWindow, fixes: this.fixesInWindow, eligible: this.eligibleInWindow };
  }
}

import type { LogicalChange } from "@code-health/history/noise";
import { changeSpread } from "../spread-measure.ts";

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** A half-open window in unix seconds. */
export interface Span {
  since: number;
  until: number;
}

/** The suite's own commits are left out of every outcome: a move commit is wide by construction. */
export const inSpan = (changes: readonly LogicalChange[], span: Span): LogicalChange[] =>
  changes.filter((c) => !c.suiteCommit && c.committerDate >= span.since && c.committerDate < span.until);

/** The changes that touch at least one of the files, by stable file identity. */
export const touching = (changes: readonly LogicalChange[], ids: ReadonlySet<string>): LogicalChange[] =>
  changes.filter((c) => c.files.some((f) => ids.has(f.fileId)));

export interface GroupFigures {
  spread: { /** Changes whose spread was measured: those at or under the maximum changeset size. */ measured: number; mean: number | null };
  revisions: { changes: number; files: number; perFile: number | null };
}

/** Change spread and revisions of the changes touching a group of files. */
export function figuresOf(changes: readonly LogicalChange[], ids: ReadonlySet<string>): GroupFigures {
  const own = touching(changes, ids);
  const spreads = own.filter((c) => !c.oversized).map((c) => changeSpread(c.files.map((f) => f.path)));
  return {
    spread: { measured: spreads.length, mean: spreads.length === 0 ? null : spreads.reduce((a, b) => a + b, 0) / spreads.length },
    revisions: { changes: own.length, files: ids.size, perFile: ids.size === 0 ? null : own.length / ids.size },
  };
}

export interface Pairing {
  actedOn: { path: string; revisions: number };
  comparison: { path: string; revisions: number } | null;
}

export interface Controls {
  group: string[];
  pairs: Pairing[];
  /** Candidates left out because they changed together with something acted on, so they cannot stand for the untouched. */
  overlapping: number;
}

/**
 * Findings are acted on because they are extreme, and extreme values drift back towards the average when left alone.
 * Each acted-on file is therefore set beside the untouched file of nearest rank, ranked by revisions in the before
 * window, one control each, ties to the lexically first path. A file that changed together with an acted-on file in
 * either window is passed over, because its changes are partly the acted-on ones.
 */
export function chooseControls(
  revisions: ReadonlyMap<string, number>,
  actedOn: readonly string[],
  overlap: ReadonlySet<string>,
): Controls {
  const acted = new Set(actedOn);
  const left = [...revisions.keys()].filter((path) => !acted.has(path));
  const pool = left.filter((path) => !overlap.has(path)).sort(byBytes);
  const available = [...pool];
  const group: string[] = [];
  const pairs: Pairing[] = [];
  const own = (path: string) => revisions.get(path) ?? 0;
  for (const target of [...actedOn].sort((a, b) => own(b) - own(a) || byBytes(a, b))) {
    let best = -1;
    for (const [index, candidate] of available.entries()) {
      if (best === -1 || Math.abs(own(candidate) - own(target)) < Math.abs(own(available[best]!) - own(target))) best = index;
    }
    if (best === -1) {
      pairs.push({ actedOn: { path: target, revisions: own(target) }, comparison: null });
      continue;
    }
    const [chosen] = available.splice(best, 1) as [string];
    group.push(chosen);
    pairs.push({ actedOn: { path: target, revisions: own(target) }, comparison: { path: chosen, revisions: own(chosen) } });
  }
  return { group, pairs, overlapping: left.length - pool.length };
}

/** Files that share a change with any of `files` among `changes`. */
export function sharingChanges(changes: readonly LogicalChange[], files: ReadonlySet<string>): Set<string> {
  const shared = new Set<string>();
  for (const change of touching(changes, files)) for (const f of change.files) if (!files.has(f.fileId)) shared.add(f.fileId);
  return shared;
}

/** Revisions of every file over the changes, by file identity. */
export function revisionsOf(changes: readonly LogicalChange[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const change of changes) for (const id of new Set(change.files.map((f) => f.fileId))) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

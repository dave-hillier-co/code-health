import { changeSpread, percentile } from "@code-health/cochange/spread-measure";
import type { LogicalChange } from "@code-health/history/noise";

/** The change spread of a set of logical changes, measured at each file's path as of that change. */
export interface SpreadSummary {
  /** Logical changes in the set. */
  changes: number;
  /** Those at or under the maximum changeset size, whose spread is measured: the sample every figure rests on. */
  measured: number;
  /** Changes over the maximum size, not measured. */
  oversized: number;
  mean: number | null;
  median: number | null;
}

export function summariseSpread(changes: readonly LogicalChange[]): SpreadSummary {
  const spreads = changes.filter((change) => !change.oversized).map((change) => changeSpread(change.files.map((file) => file.path)));
  return {
    changes: changes.length,
    measured: spreads.length,
    oversized: changes.length - spreads.length,
    mean: spreads.length === 0 ? null : spreads.reduce((sum, value) => sum + value, 0) / spreads.length,
    median: percentile(spreads, 0.5),
  };
}

/** The changes, in order, that touch any of the files, named by their stable identity. */
export function changesTouching(changes: readonly LogicalChange[], fileIds: ReadonlySet<string>): LogicalChange[] {
  return changes.filter((change) => change.files.some((file) => fileIds.has(file.fileId)));
}

/** The changes whose committer date falls in `[since, until)`. */
export function changesBetween(changes: readonly LogicalChange[], since: number, until: number): LogicalChange[] {
  return changes.filter((change) => change.committerDate >= since && change.committerDate < until);
}

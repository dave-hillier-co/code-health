import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { LoadedHistory } from "./history-access.ts";
import { countCoupling, type CouplingCounts } from "./coupling.ts";

/** Reads an integer option within bounds, or the fallback when it is not given. */
export function integerOption(context: CommandContext, option: string, fallback: number, min: number, max: number): number {
  const raw = context.values[option];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw usageError(`--${option} must be an integer from ${min} to ${max}, got "${String(raw)}"`);
  }
  return Number(raw);
}

/**
 * Pairs reaching the guidelines over the eligible logical changes. A file deleted at the end of the
 * window is no use to co-locate, so pairs with one are left out. Counts for the surviving files are
 * unchanged: only the pair is dropped.
 */
export function coupledPairs(history: LoadedHistory, guidelines: { minSupport: number; minDegree: number }): CouplingCounts {
  const lastStatus = new Map<string, string>();
  for (const change of history.filtered.changes) {
    for (const file of change.files) lastStatus.set(file.fileId, file.status);
  }
  const counts = countCoupling(
    history.filtered.changes.map((change) => ({ files: change.files.map((file) => file.fileId), oversized: change.oversized })),
    guidelines,
  );
  const gone = (id: string) => lastStatus.get(id) === "D";
  return { ...counts, pairs: counts.pairs.filter((pair) => !gone(pair.a) && !gone(pair.b)) };
}

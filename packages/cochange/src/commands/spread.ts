import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import type { LogicalChange } from "@code-health/history/noise";
import { analysisCommand } from "../analysis-command.ts";
import { readSettings } from "../config.ts";
import type { ExplicitWindow } from "../history-access.ts";
import {
  bucketLabel,
  bucketStart,
  changeSpread,
  hasCodeHealthTrailer,
  nextBucketStart,
  parseDate,
  percentile,
  type Bucket,
} from "../spread-measure.ts";

export const name = "spread";

interface Distribution {
  /** Logical changes in the bucket, after leaving out the suite's own commits. */
  logicalChanges: number;
  /** Changes whose spread was measured: those at or under the maximum changeset size. */
  measured: number;
  /** Measured changes that touch one file, and so have spread 0. */
  singleFile: number;
  /** Changes over the maximum changeset size: not measured. */
  oversized: number;
  /** `oversized / logicalChanges`, null for an empty bucket. */
  oversizedShare: number | null;
  /** Changes whose commit carries a `Code-Health:` trailer. Not part of `logicalChanges`. */
  excludedByTrailer: number;
  mean: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}

function distribution(changes: LogicalChange[], excludedByTrailer: number): Distribution {
  const measured = changes.filter((c) => !c.oversized).map((c) => changeSpread(c.files.map((f) => f.path)));
  const oversized = changes.length - measured.length;
  return {
    logicalChanges: changes.length,
    measured: measured.length,
    singleFile: changes.filter((c) => !c.oversized && c.files.length === 1).length,
    oversized,
    oversizedShare: changes.length === 0 ? null : oversized / changes.length,
    excludedByTrailer,
    mean: measured.length === 0 ? null : measured.reduce((a, b) => a + b, 0) / measured.length,
    median: percentile(measured, 0.5),
    p75: percentile(measured, 0.75),
    p90: percentile(measured, 0.9),
    max: measured.length === 0 ? null : Math.max(...measured),
  };
}

function bucketOption(context: CommandContext): Bucket {
  const value = context.values.bucket;
  if (value === undefined) return "month";
  if (value === "week" || value === "month") return value;
  throw usageError(`--bucket must be "week" or "month", not "${String(value)}"`);
}

function dateOption(context: CommandContext, option: "since" | "until"): number | undefined {
  const value = context.values[option];
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? parseDate(value) : null;
  if (parsed === null) {
    throw usageError(`--${option} must be an ISO 8601 date such as 2024-03-01, not "${String(value)}"`);
  }
  return parsed;
}

/**
 * The window the options state. `--since` is inclusive and `--until`
 * exclusive. A bare `--until` looks back the configured window from that date.
 */
function statedWindow(context: CommandContext): ExplicitWindow | undefined {
  const since = dateOption(context, "since");
  const until = dateOption(context, "until");
  if (since === undefined && until === undefined) return undefined;
  const effectiveSince = since ?? monthsBefore(until!, readSettings(context.config).windowMonths);
  if (until !== undefined && effectiveSince >= until) throw usageError("--since must be before --until");
  return { since: effectiveSince, until };
}

export const command = analysisCommand(name, {
  summary: "Change-spread distribution (mean pairwise tree distance per logical change) per week or month",
  options: { since: { type: "string" }, until: { type: "string" }, bucket: { type: "string" } },
  window: statedWindow,
  partial: (context) => bucketOption(context) !== "month",
  analyse({ context, history }) {
    const bucket = bucketOption(context);
    const messages = new Map(history.view.commits.map((c) => [c.sha, c.message]));

    const measuredChanges: LogicalChange[] = [];
    let excluded: LogicalChange[] = [];
    for (const change of history.filtered.changes) {
      const ownCommit = change.shas.some((sha) => hasCodeHealthTrailer(messages.get(sha) ?? ""));
      (ownCommit ? excluded : measuredChanges).push(change);
    }

    const byBucket = new Map<number, { changes: LogicalChange[]; excluded: number }>();
    const slot = (time: number) => {
      const start = bucketStart(time, bucket);
      let entry = byBucket.get(start);
      if (!entry) byBucket.set(start, (entry = { changes: [], excluded: 0 }));
      return entry;
    };
    for (const change of measuredChanges) slot(change.committerDate).changes.push(change);
    for (const change of excluded) slot(change.committerDate).excluded++;

    // One row for every bucket from the first with any change to the end of
    // the window, so a quiet stretch shows as a gap and not as a missing row.
    const rows: (Distribution & { bucket: string; start: string })[] = [];
    if (byBucket.size > 0) {
      const first = Math.min(...byBucket.keys());
      const last = bucketStart(history.window.until - (context.values.until === undefined ? 0 : 1), bucket);
      for (let start = first; start <= last; start = nextBucketStart(start, bucket)) {
        const entry = byBucket.get(start);
        rows.push({
          bucket: bucketLabel(start, bucket),
          start: new Date(start * 1000).toISOString(),
          ...distribution(entry?.changes ?? [], entry?.excluded ?? 0),
        });
      }
    }

    return {
      inputs: { bucket, trailerExcluded: "Code-Health" },
      results: { bucket, overall: distribution(measuredChanges, excluded.length), buckets: rows },
    };
  },
});

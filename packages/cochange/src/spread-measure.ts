import { treeDistance } from "@code-health/graph/tree-distance";

/**
 * Change spread of one logical change: the mean tree distance over every pair
 * of its files. The paths must be the files' paths as of that change. A change
 * of one file, or of none, has spread 0.
 */
export function changeSpread(paths: readonly string[]): number {
  const distinct = [...new Set(paths)];
  const n = distinct.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) total += treeDistance(distinct[i]!, distinct[j]!);
  }
  return total / ((n * (n - 1)) / 2);
}

/**
 * The p-th percentile (0 to 1) by linear interpolation between closest ranks
 * (the "type 7" definition used by most statistics packages). Null for no values.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export type Bucket = "week" | "month";

const DAY = 86400;

/** Unix seconds of the start of the bucket (UTC) holding `time`. Weeks start on Monday. */
export function bucketStart(time: number, bucket: Bucket): number {
  const date = new Date(time * 1000);
  if (bucket === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY;
}

/** The start of the bucket after the one starting at `start`. */
export function nextBucketStart(start: number, bucket: Bucket): number {
  if (bucket === "week") return start + 7 * DAY;
  const date = new Date(start * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
}

/** `2024-03` for a month, the Monday's date (`2024-03-04`) for a week. */
export function bucketLabel(start: number, bucket: Bucket): string {
  const iso = new Date(start * 1000).toISOString();
  return bucket === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/**
 * True when the message carries a `Code-Health:` trailer: a `Code-Health:` line
 * in the last paragraph, which must follow the subject paragraph. The key is
 * matched case-insensitively, as git's own trailer parsing does.
 */
export function hasCodeHealthTrailer(message: string): boolean {
  const paragraphs = message
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return false;
  return paragraphs[paragraphs.length - 1]!.split("\n").some((line) => /^code-health[ \t]*:/i.test(line));
}

/** Strict date parsing for `--since` and `--until`: `YYYY-MM-DD` (UTC midnight) or an ISO 8601 date-time with a zone. Unix seconds, or null. */
export function parseDate(text: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(text);
  if (!day) return null;
  // The calendar day must exist, in either form: February 31st is not silently March 2nd.
  const midnight = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  if (new Date(midnight).toISOString().slice(0, 10) !== text.slice(0, 10)) return null;
  if (day[4] === undefined) return midnight / 1000;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

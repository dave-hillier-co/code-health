import type { ImportedHistory } from "./imported.ts";
import { filterHistory, type FilteredHistory, type FiltersApplied, type LogicalChange, type NoiseOptions } from "./noise.ts";
import { readHistory, type HistoryView, type ReadOptions } from "./read.ts";
import { readShallowInfo, type ShallowInfo } from "./refresh.ts";

export type Grade = "strong" | "moderate" | "weak";

export interface GradeThreshold {
  /** Months of usable history. */
  months: number;
  /** Logical changes in the analysis window. */
  logicalChanges: number;
  /** Distinct active contributors in the window. */
  contributors: number;
}

export interface EvidenceThresholds {
  strong: GradeThreshold;
  moderate: GradeThreshold;
}

export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = {
  strong: { months: 24, logicalChanges: 300, contributors: 5 },
  moderate: { months: 6, logicalChanges: 50, contributors: 2 },
};

export const DEFAULT_WINDOW_MONTHS = 12;

export interface EvidenceOptions {
  /** Analysis window in months back from the head commit's date. Default 12. */
  windowMonths?: number;
  thresholds?: EvidenceThresholds;
  /** Changes needed in each half before a commit-size shift is reported. Default 20. */
  minChangesForShift?: number;
}

/**
 * Median files per logical change in the earlier and later half of the usable
 * history. A large move either way usually means a change of merge policy
 * (to or from squash merges), after which a commit means something different.
 */
export interface CommitSize {
  earlierMedian: number;
  laterMedian: number;
  /** The later median is at least double, or at most half, the earlier one. */
  shifted: boolean;
}

/** The suite's repository-level `evidence` block. */
export interface Evidence {
  /** Months between the first usable change and the head commit, to one decimal. */
  usableHistoryMonths: number;
  logicalChangesInWindow: number;
  activeContributors: number;
  grade: Grade;
  window: { months: number; since: number; until: number };
  truncated: {
    /** The clone is shallow: history before `availableSince` is missing. */
    shallow: boolean;
    boundaryCommits: number;
    /** Committer date of the oldest commit available, unix seconds. */
    availableSince: number | null;
  };
  importedHistory: ImportedHistory[];
  commitSize: CommitSize;
  thresholds: EvidenceThresholds;
}

const SECONDS_PER_MONTH = 30.4375 * 86_400;

/** Unix seconds `months` calendar months before `anchor`, in UTC. */
export function monthsBefore(anchor: number, months: number): number {
  const date = new Date(anchor * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return Math.floor(date.getTime() / 1000);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function commitSize(changes: readonly LogicalChange[], minChanges: number): CommitSize {
  const half = changes.length >> 1;
  const earlier = changes.slice(0, half).map((c) => c.files.length);
  const later = changes.slice(half).map((c) => c.files.length);
  const earlierMedian = median(earlier);
  const laterMedian = median(later);
  const enough = earlier.length >= minChanges && later.length >= minChanges;
  const shifted = enough && earlierMedian > 0 && (laterMedian >= earlierMedian * 2 || laterMedian <= earlierMedian / 2);
  return { earlierMedian, laterMedian, shifted };
}

const meets = (t: GradeThreshold, months: number, changes: number, contributors: number) =>
  months >= t.months && changes >= t.logicalChanges && contributors >= t.contributors;

export function computeEvidence(
  view: HistoryView,
  changes: readonly LogicalChange[],
  shallow: ShallowInfo,
  imported: readonly ImportedHistory[],
  options: EvidenceOptions = {},
): Evidence {
  const windowMonths = options.windowMonths ?? DEFAULT_WINDOW_MONTHS;
  const thresholds = options.thresholds ?? DEFAULT_EVIDENCE_THRESHOLDS;
  const until = view.headDate;
  const since = monthsBefore(until, windowMonths);

  // Usable history starts after the latest import: what came before it is a stub.
  const afterImport = imported.reduce((max, i) => Math.max(max, i.committerDate), -Infinity);
  const first = changes
    .filter((c) => c.committerDate >= afterImport)
    .reduce<number | null>((min, c) => (min === null || c.committerDate < min ? c.committerDate : min), null);
  const usableHistoryMonths = first === null ? 0 : Math.round(((until - first) / SECONDS_PER_MONTH) * 10) / 10;

  const inWindow = changes.filter((c) => c.committerDate >= since && c.committerDate <= until);
  const contributors = new Set(inWindow.flatMap((c) => c.authors.map((a) => a.toLowerCase())));

  const grade: Grade = meets(thresholds.strong, usableHistoryMonths, inWindow.length, contributors.size)
    ? "strong"
    : meets(thresholds.moderate, usableHistoryMonths, inWindow.length, contributors.size)
      ? "moderate"
      : "weak";

  const available = view.commits.reduce<number | null>(
    (min, c) => (min === null || c.committerDate < min ? c.committerDate : min),
    null,
  );
  return {
    usableHistoryMonths,
    logicalChangesInWindow: inWindow.length,
    activeContributors: contributors.size,
    grade,
    window: { months: windowMonths, since, until },
    truncated: { shallow: shallow.isShallow, boundaryCommits: shallow.boundary.length, availableSince: shallow.isShallow ? available : null },
    importedHistory: [...imported],
    commitSize: commitSize(changes, options.minChangesForShift ?? 20),
    thresholds,
  };
}

export interface HistoryAnalysisOptions extends ReadOptions {
  noise?: NoiseOptions;
  evidence?: EvidenceOptions;
}

export interface HistoryAnalysis {
  view: HistoryView;
  /** Filtered changes over the whole usable history. Apply the window with `window.since`. */
  filtered: FilteredHistory;
  filtersApplied: FiltersApplied;
  evidence: Evidence;
}

/**
 * Reads the cached history for a ref, applies the noise filters and computes
 * the evidence block. Call `refresh` first.
 */
export async function analyseHistory(repoPath: string, options: HistoryAnalysisOptions = {}): Promise<HistoryAnalysis> {
  const view = await readHistory(repoPath, options);
  const filtered = await filterHistory(repoPath, view, options.noise);
  // Usable history and the grade are properties of the whole repository, so a
  // window passed through the noise options must not clip them.
  const windowed = options.noise?.since !== undefined || options.noise?.until !== undefined;
  const whole = windowed
    ? await filterHistory(repoPath, view, { ...options.noise, since: undefined, until: undefined })
    : filtered;
  const shallow = await readShallowInfo(repoPath);
  const evidence = computeEvidence(view, whole.changes, shallow, whole.imported, options.evidence);
  return { view, filtered, filtersApplied: filtered.filtersApplied, evidence };
}

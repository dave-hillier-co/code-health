import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { coChangeDegree } from "@code-health/history/co-change";
import { analyseHistory, monthsBefore, type Grade } from "@code-health/history/evidence";
import { readShallowInfo, refresh } from "@code-health/history/refresh";
import type { LocalitySettings } from "./config.ts";

const SECONDS_PER_DAY = 86_400;

/** What one unit's files, consumers and blockers did over the history, for the enrichment step of the analysis. */
export interface History {
  headDate: number;
  window: { months: number; since: number; until: number };
  evidence: { grade: Grade; logicalChangesInWindow: number; usableHistoryMonths: number; activeContributors: number };
  /** Logical changes in the window small enough to count for coupling, as sets of files. */
  changes: readonly ReadonlySet<string>[];
  /** For each file, the positions in `changes` of the logical changes that touch it. */
  changesOf: ReadonlyMap<string, readonly number[]>;
  /** First and latest committer date of each file over the whole usable history. */
  firstSeen: ReadonlyMap<string, number>;
  lastChanged: ReadonlyMap<string, number>;
  /** Lines added and deleted per file in the window. */
  churn: ReadonlyMap<string, number>;
}

/**
 * Reads the history cache, refreshing it first as every analysis does. Returns undefined when history
 * cannot give an honest answer (a shallow clone, or no commits), so the analysis runs on static signals alone.
 */
export async function readHistory(context: CommandContext, settings: LocalitySettings): Promise<History | undefined> {
  const { root } = context.repo;
  try {
    if ((await readShallowInfo(root)).isShallow) return undefined;
    await refresh(root, { ref: "HEAD" });
    const analysis = await analyseHistory(root, { ref: "HEAD", noise: { exclude: [...settings.exclude] }, evidence: { windowMonths: settings.windowMonths } });
    const until = analysis.view.headDate;
    const since = monthsBefore(until, settings.windowMonths);
    const firstSeen = new Map<string, number>();
    const lastChanged = new Map<string, number>();
    const churn = new Map<string, number>();
    const changes: Set<string>[] = [];
    const changesOf = new Map<string, number[]>();
    for (const change of analysis.filtered.changes) {
      const inWindow = change.committerDate >= since && change.committerDate <= until;
      for (const file of change.files) {
        const first = firstSeen.get(file.fileId);
        if (first === undefined || change.committerDate < first) firstSeen.set(file.fileId, change.committerDate);
        const last = lastChanged.get(file.fileId);
        if (last === undefined || change.committerDate > last) lastChanged.set(file.fileId, change.committerDate);
        if (inWindow) churn.set(file.fileId, (churn.get(file.fileId) ?? 0) + (file.added ?? 0) + (file.deleted ?? 0));
      }
      if (inWindow && !change.oversized) {
        const files = new Set(change.files.map((file) => file.fileId));
        for (const file of files) changesOf.set(file, [...(changesOf.get(file) ?? []), changes.length]);
        changes.push(files);
      }
    }
    const { grade, logicalChangesInWindow, usableHistoryMonths, activeContributors } = analysis.evidence;
    return {
      headDate: until,
      window: { months: settings.windowMonths, since, until },
      evidence: { grade, logicalChangesInWindow, usableHistoryMonths, activeContributors },
      changes,
      changesOf,
      firstSeen,
      lastChanged,
      churn,
    };
  } catch {
    return undefined;
  }
}

export const ageDays = (history: History, path: string): number | null => {
  const first = history.firstSeen.get(path);
  return first === undefined ? null : Math.max(0, Math.floor((history.headDate - first) / SECONDS_PER_DAY));
};

export const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** Co-change of a group of files (a unit, moving as one) with another file, over the window's logical changes. */
export interface Pairing {
  /** Logical changes touching the group and the file. */
  support: number;
  /** Logical changes touching the group. */
  groupChanges: number;
  /** Logical changes touching the file. */
  fileChanges: number;
  /** The suite's symmetric degree, a percentage, one decimal. */
  degree: number;
}

export function pairing(history: History, group: ReadonlySet<string>, file: string): Pairing {
  const touchingGroup = new Set<number>();
  for (const member of group) for (const index of history.changesOf.get(member) ?? []) touchingGroup.add(index);
  const touchingFile = history.changesOf.get(file) ?? [];
  const support = touchingFile.filter((index) => touchingGroup.has(index)).length;
  return { support, groupChanges: touchingGroup.size, fileChanges: touchingFile.length, degree: round1(coChangeDegree(support, touchingGroup.size, touchingFile.length)) };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

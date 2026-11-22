import { checkFixConvention, fixEvidence, subjectOf, type FixClassifier, type FixConvention, type FixEvidence } from "@code-health/history/fix-commits";
import { monthsBefore } from "@code-health/history/evidence";
import type { Unit } from "./file-statistics.ts";
import type { LoadedHistory } from "./history-access.ts";
import { isoDate } from "./units.ts";

/** One commit that made a logical change count as a fix, with the pattern that matched. */
export interface FixCommit {
  sha: string;
  date: string;
  subject: string;
  pattern: string;
  matchedIn: "subject" | "body";
}

/** What the commit messages say about one logical change. */
interface ChangeClass {
  /** The first commit of the change that is a fix, or null. */
  fix: FixCommit | null;
  /** The first commit of the change that a fix pattern matched and an exclude pattern removed. Null when the change is a fix or has none. */
  excluded: FixCommit | null;
  /** Some commit of the change is a revert. A revert message is never also a fix. */
  revert: boolean;
}

/** What the commit messages say about the changes that touched one file or component. */
export interface FixStatistics {
  /** Logical changes that are fixes. Counted once per unit, as `revisions` is. */
  fixes: number;
  /** Logical changes that are reverts, a separate column: a revert is not a fix. */
  reverts: number;
  /** Fixes over revisions, 3 decimals. Null with no revisions. */
  fixShare: number | null;
  /** Fixes committed within the recent window. */
  recentFixes: number;
  /** Committer date of the latest fix, or null. */
  lastFix: string | null;
  /** The matching commits, newest first. */
  commits: FixCommit[];
}

export interface FixReading {
  statistics: Map<string, FixStatistics>;
  convention: FixConvention;
  /** Logical changes in the window that a fix pattern matched and an exclude pattern removed, by the excluding pattern. They are not counted as fixes. */
  excluded: FixEvidence;
}

/** The statistics of a unit, all zero for a unit that no fix or revert touched. The share is over the unit's revisions. */
export function statisticsOf(reading: FixReading, unit: Unit): FixStatistics {
  const found = reading.statistics.get(unit.name) ?? { fixes: 0, reverts: 0, fixShare: null, recentFixes: 0, lastFix: null, commits: [] };
  return { ...found, fixShare: unit.revisions === 0 ? null : Math.round((found.fixes / unit.revisions) * 1000) / 1000 };
}

/**
 * Classifies the logical changes in the window that hotspots counts (same window, noise filters, rename following and
 * bot exclusion, oversized changes included) and attributes each to the units it touched, once per unit.
 * The convention check runs over every logical change in the window, including those touching only files that are gone.
 */
export function readFixes(history: LoadedHistory, units: readonly Unit[], classifier: FixClassifier): FixReading {
  const commits = new Map(history.view.commits.map((commit) => [commit.sha, commit]));
  const unitOf = new Map<string, string>();
  for (const unit of units) for (const member of unit.members) unitOf.set(member, unit.name);
  const recentSince = monthsBefore(history.view.headDate, history.settings.recentMonths);

  const found = new Map<string, { commit: FixCommit; time: number }[]>();
  const reverts = new Map<string, number>();
  let fixChanges = 0;
  const excludedMatches: FixCommit[] = [];
  for (const change of history.filtered.changes) {
    const classed = classify(change.shas, change.committerDate, commits, classifier);
    if (classed.fix) fixChanges++;
    else if (classed.excluded) excludedMatches.push(classed.excluded);
    const touched = new Set<string>();
    for (const file of change.files) {
      const name = unitOf.get(file.fileId);
      if (name !== undefined) touched.add(name);
    }
    for (const name of touched) {
      if (classed.fix) found.set(name, [...(found.get(name) ?? []), { commit: classed.fix, time: change.committerDate }]);
      if (classed.revert) reverts.set(name, (reverts.get(name) ?? 0) + 1);
    }
  }

  const statistics = new Map<string, FixStatistics>();
  for (const name of new Set([...found.keys(), ...reverts.keys()])) {
    const newestFirst = (found.get(name) ?? []).map((entry, index) => ({ ...entry, index })).sort((a, b) => b.time - a.time || b.index - a.index);
    statistics.set(name, {
      fixes: newestFirst.length,
      reverts: reverts.get(name) ?? 0,
      fixShare: null,
      recentFixes: newestFirst.filter((entry) => entry.time >= recentSince).length,
      lastFix: newestFirst[0]?.commit.date ?? null,
      commits: newestFirst.map((entry) => entry.commit),
    });
  }
  const excluded = fixEvidence(excludedMatches.map((commit) => ({ id: commit.sha, subject: commit.subject, pattern: commit.pattern, matchedIn: commit.matchedIn })));
  return { statistics, convention: checkFixConvention(history.filtered.changes.length, fixChanges), excluded };
}

function classify(
  shas: readonly string[],
  committerDate: number,
  commits: ReadonlyMap<string, { message: string }>,
  classifier: FixClassifier,
): ChangeClass {
  let fix: FixCommit | null = null;
  let excluded: FixCommit | null = null;
  let revert = false;
  for (const sha of shas) {
    const message = commits.get(sha)?.message;
    if (message === undefined) continue;
    const kind = classifier.classify(message);
    if (kind.kind === "revert") revert = true;
    if (kind.kind === "fix" && fix === null) {
      fix = { sha, date: isoDate(committerDate), subject: subjectOf(message), pattern: kind.pattern, matchedIn: kind.matchedIn };
    }
    if (kind.kind === "excluded" && excluded === null) {
      excluded = { sha, date: isoDate(committerDate), subject: subjectOf(message), pattern: kind.pattern, matchedIn: kind.matchedIn };
    }
  }
  return { fix, excluded: fix === null ? excluded : null, revert };
}

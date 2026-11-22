import { checkFixConvention, fixEvidence, subjectOf, type FixClassifier, type FixConvention, type FixEvidence } from "@code-health/history/fix-commits";
import { monthsBefore } from "@code-health/history/evidence";
import { groupByLanding, readLandings, type Landing } from "@code-health/history/landings";
import type { Unit } from "./file-statistics.ts";
import type { LoadedHistory } from "./history-access.ts";
import { isoDate } from "./units.ts";

/** One landed change that counts as a fix, or one commit of a branch that does, with the pattern that matched. */
export interface FixCommit {
  /** The commit on the first-parent line (for a fix during review, the commit of the branch). */
  sha: string;
  date: string;
  /** The change's title: the pull request title of a merge, the subject of a squash or direct commit. */
  subject: string;
  pattern: string;
  matchedIn: "subject" | "body";
}

/** What the commit messages say about one landed change. */
interface ChangeClass {
  /** The change as a fix, or null. */
  fix: FixCommit | null;
  /** The change when a fix pattern matched and an exclude pattern removed it. Null when the change is a fix or has none. */
  excluded: FixCommit | null;
  /** The change is a revert. A revert message is never also a fix. */
  revert: boolean;
}

/** What the commit messages say about the landed changes that touched one file or component. */
export interface FixStatistics {
  /** Landed changes that touched the unit. The denominator of `fixShare`. */
  landedChanges: number;
  /** Landed changes that are fixes, by their own title. Counted once per unit. */
  fixes: number;
  /** Landed changes that are reverts, a separate column: a revert is not a fix. */
  reverts: number;
  /** Fixes over landed changes, 3 decimals. Null with no landed change. */
  fixShare: number | null;
  /** Fixes landed within the recent window. */
  recentFixes: number;
  /** Date of the latest fix, or null. */
  lastFix: string | null;
  /** The landed fixes, newest first. */
  commits: FixCommit[];
  /** Commits made on a branch before it merged that look like fixes and touched the unit. They were caught in review, so they are not counted in `fixes`. */
  reviewFixes: number;
  /** Those commits, newest first. */
  reviewCommits: FixCommit[];
}

export interface FixReading {
  statistics: Map<string, FixStatistics>;
  convention: FixConvention;
  /** Landed changes in the window that a fix pattern matched and an exclude pattern removed, by the excluding pattern. They are not counted as fixes. */
  excluded: FixEvidence;
  /** Commits of merged branches in the window that look like fixes, over the whole window. They are not counted as fixes. */
  reviewFixes: FixEvidence;
}

const empty = (): FixStatistics => ({ landedChanges: 0, fixes: 0, reverts: 0, fixShare: null, recentFixes: 0, lastFix: null, commits: [], reviewFixes: 0, reviewCommits: [] });

/** The statistics of a unit, all zero for a unit that no landed change touched. The share is over the landed changes that touched the unit. */
export function statisticsOf(reading: FixReading, unit: Unit): FixStatistics {
  return reading.statistics.get(unit.name) ?? empty();
}

/**
 * Classifies the landed changes in the window that hotspots reads (same window, noise filters, rename following and
 * bot exclusion, oversized changes included) and attributes each to the units it touched, once per unit. A landed change is
 * a merge with the commits it brought in, or one commit on the first-parent line, and it is classified by its own text:
 * the pull request title of a merge, the message of any other commit. The commits only a merge's later parents reach are
 * not classified as changes: their fix-like messages are counted apart, as fixes during review.
 * The convention check runs over every landed change in the window, including those touching only files that are gone.
 */
export async function readFixes(history: LoadedHistory, units: readonly Unit[], classifier: FixClassifier, root: string): Promise<FixReading> {
  const landings = await readLandings(root, history.view.headSha);
  const commits = new Map(history.view.commits.map((commit) => [commit.sha, commit]));
  const unitOf = new Map<string, string>();
  for (const unit of units) for (const member of unit.members) unitOf.set(member, unit.name);
  const recentSince = monthsBefore(history.view.headDate, history.settings.recentMonths);

  const found = new Map<string, FixStatistics>();
  const statsOf = (name: string): FixStatistics => {
    let stats = found.get(name);
    if (stats === undefined) found.set(name, (stats = empty()));
    return stats;
  };
  let fixChanges = 0;
  const titles: string[] = [];
  const excludedMatches: FixCommit[] = [];
  const reviewMatches: FixCommit[] = [];
  for (const { landing, changes } of groupByLanding(history.filtered.changes, landings)) {
    const classed = classify(landing, classifier);
    titles.push(landing.text);
    if (classed.fix) fixChanges++;
    else if (classed.excluded) excludedMatches.push(classed.excluded);

    const review = reviewFixesOf(landing, classifier, (sha) => commits.get(sha)?.committerDate ?? landing.time);
    const touched = new Set<string>();
    const reviewTouched = new Map<string, Set<string>>();
    const reviewSeen = new Set<string>();
    for (const change of changes) {
      const names = new Set<string>();
      for (const file of change.files) {
        const name = unitOf.get(file.fileId);
        if (name !== undefined) names.add(name);
      }
      for (const name of names) touched.add(name);
      for (const sha of change.shas) {
        if (!review.has(sha)) continue;
        reviewSeen.add(sha);
        for (const name of names) reviewTouched.set(name, (reviewTouched.get(name) ?? new Set<string>()).add(sha));
      }
    }
    for (const sha of reviewSeen) reviewMatches.push(review.get(sha)!.commit);

    for (const name of touched) {
      const stats = statsOf(name);
      stats.landedChanges++;
      if (classed.fix) {
        stats.fixes++;
        stats.commits.push(classed.fix);
        if (landing.time >= recentSince) stats.recentFixes++;
      }
      if (classed.revert) stats.reverts++;
    }
    for (const [name, shas] of reviewTouched) {
      const stats = statsOf(name);
      for (const sha of shas) stats.reviewCommits.push(review.get(sha)!.commit);
    }
  }

  for (const stats of found.values()) {
    stats.commits.reverse();
    stats.lastFix = stats.commits[0]?.date ?? null;
    stats.fixShare = stats.landedChanges === 0 ? null : Math.round((stats.fixes / stats.landedChanges) * 1000) / 1000;
    stats.reviewCommits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    stats.reviewFixes = stats.reviewCommits.length;
  }
  const evidence = (matches: readonly FixCommit[]): FixEvidence => fixEvidence(matches.map((commit) => ({ id: commit.sha, subject: commit.subject, pattern: commit.pattern, matchedIn: commit.matchedIn })));
  return { statistics: found, convention: checkFixConvention(titles, fixChanges), excluded: evidence(excludedMatches), reviewFixes: evidence(reviewMatches) };
}

function classify(landing: Landing, classifier: FixClassifier): ChangeClass {
  const kind = classifier.classify(landing.text);
  const at = (matched: { pattern: string; matchedIn: "subject" | "body" }): FixCommit => ({ sha: landing.id, date: isoDate(landing.time), subject: landing.title, pattern: matched.pattern, matchedIn: matched.matchedIn });
  return {
    fix: kind.kind === "fix" ? at(kind) : null,
    excluded: kind.kind === "excluded" ? at(kind) : null,
    revert: kind.kind === "revert",
  };
}

/** The fix-like commits of the branch a merge brought in, by SHA. A commit with the fix excluded or a revert is not one. */
function reviewFixesOf(landing: Landing, classifier: FixClassifier, timeOf: (sha: string) => number): Map<string, { commit: FixCommit }> {
  const found = new Map<string, { commit: FixCommit }>();
  for (const { sha, message } of landing.branch) {
    const kind = classifier.classify(message);
    if (kind.kind !== "fix") continue;
    found.set(sha, { commit: { sha, date: isoDate(timeOf(sha)), subject: subjectOf(message), pattern: kind.pattern, matchedIn: kind.matchedIn } });
  }
  return found;
}

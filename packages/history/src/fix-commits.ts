import { historyDefaults } from "@code-health/cli-kit/config";
import { InvalidPatternError } from "./noise.ts";

/** The settings that define a fix commit: the effective `history.fixPatterns`, `fixExcludePatterns`, `revertPatterns` and `fixMatchBody`. */
export interface FixSettings {
  fixPatterns: readonly string[];
  /** Matched against the subject of a commit a fix pattern matched: a match counts the commit as excluded, with that pattern, and not as a fix. */
  fixExcludePatterns: readonly string[];
  revertPatterns: readonly string[];
  fixMatchBody: boolean;
}

export const defaultFixSettings: FixSettings = {
  fixPatterns: historyDefaults.fixPatterns,
  fixExcludePatterns: historyDefaults.fixExcludePatterns,
  revertPatterns: historyDefaults.revertPatterns,
  fixMatchBody: historyDefaults.fixMatchBody,
};

/** The pattern named for the "This reverts commit <sha>" line that `git revert` writes into the body. */
export const REVERT_BODY_PATTERN = "This reverts commit";

/** How one commit message was classified, with the pattern that decided it. */
export type CommitClass =
  | { kind: "fix"; pattern: string; matchedIn: "subject" | "body" }
  | { kind: "revert"; pattern: string; matchedIn: "subject" | "body" }
  /** A fix pattern matched, and the exclude pattern `pattern` says the fix target is formatting, lint, typos, docs or tests. `fixPattern` is the one that matched as a fix. */
  | { kind: "excluded"; pattern: string; fixPattern: string; matchedIn: "subject" | "body" }
  | { kind: "other" };

/** A commit (or merged change) classified as a fix, kept as evidence for a count. */
export interface FixMatch {
  /** The commit, or the main-line commit of a merged change. */
  id: string;
  subject: string;
  pattern: string;
  matchedIn: "subject" | "body";
}

export interface FixClassifier {
  readonly settings: FixSettings;
  /** Classifies one commit message. A revert is checked first, so "Revert \"Fix the parser\"" is a revert and not a fix. */
  classify(message: string): CommitClass;
}

const REVERT_BODY = /^This reverts commit [0-9a-f]{7,40}/m;

export const subjectOf = (message: string): string => message.split("\n", 1)[0]!.trim();

function compile(pattern: string, flags: string, kind: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new InvalidPatternError(pattern, error instanceof Error ? error.message : String(error), kind);
  }
}

/** Compiles the settings once. Throws `InvalidPatternError` for a pattern that is not a regular expression. */
export function compileFixClassifier(settings: FixSettings): FixClassifier {
  const fixes = settings.fixPatterns.map((source) => ({ source, subject: compile(source, "i", "fix pattern"), body: compile(source, "im", "fix pattern") }));
  const excludes = settings.fixExcludePatterns.map((source) => ({ source, subject: compile(source, "i", "fix exclude pattern") }));
  const reverts = settings.revertPatterns.map((source) => ({ source, subject: compile(source, "i", "revert pattern") }));

  const classify = (message: string): CommitClass => {
    const normalised = message.replace(/\r\n/g, "\n");
    const subject = subjectOf(normalised);
    const body = normalised.slice(normalised.indexOf("\n") === -1 ? normalised.length : normalised.indexOf("\n") + 1);
    const revert = reverts.find((entry) => entry.subject.test(subject));
    if (revert) return { kind: "revert", pattern: revert.source, matchedIn: "subject" };
    if (REVERT_BODY.test(body)) return { kind: "revert", pattern: REVERT_BODY_PATTERN, matchedIn: "body" };
    const fix = fixes.find((entry) => entry.subject.test(subject));
    const inBody = fix === undefined && settings.fixMatchBody ? fixes.find((entry) => entry.body.test(body)) : undefined;
    const matched = fix ?? inBody;
    if (matched === undefined) return { kind: "other" };
    const matchedIn = fix === undefined ? "body" : "subject";
    const excluded = excludes.find((entry) => entry.subject.test(subject));
    if (excluded) return { kind: "excluded", pattern: excluded.source, fixPattern: matched.source, matchedIn };
    return { kind: "fix", pattern: matched.source, matchedIn };
  };

  return { settings, classify };
}

/** The first message of a change that is a fix, as evidence under `id`. Null when none is. A revert among them is not a fix. */
export function findFix(classifier: FixClassifier, id: string, messages: readonly string[]): FixMatch | null {
  for (const message of messages) {
    const found = classifier.classify(message);
    if (found.kind === "fix") return { id, subject: subjectOf(message), pattern: found.pattern, matchedIn: found.matchedIn };
  }
  return null;
}

/**
 * The first message of a change that a fix pattern matched and an exclude pattern removed, as evidence under `id`, with the pattern
 * that excluded it. Null when none is, or when a message of the change is a fix, because the change then counts as one.
 */
export function findExcludedFix(classifier: FixClassifier, id: string, messages: readonly string[]): FixMatch | null {
  if (findFix(classifier, id, messages) !== null) return null;
  for (const message of messages) {
    const found = classifier.classify(message);
    if (found.kind === "excluded") return { id, subject: subjectOf(message), pattern: found.pattern, matchedIn: found.matchedIn };
  }
  return null;
}

/** The evidence behind a count of fixes: how many, which patterns matched, and the first commits that did. */
export interface FixEvidence {
  fixes: number;
  byPattern: { pattern: string; count: number }[];
  /** The first matches in the order given, at most the limit. */
  commits: FixMatch[];
  /** Matches beyond `commits`. */
  omitted: number;
}

export const FIX_EVIDENCE_LIMIT = 20;

export function fixEvidence(matches: readonly FixMatch[], limit = FIX_EVIDENCE_LIMIT): FixEvidence {
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.pattern, (counts.get(match.pattern) ?? 0) + 1);
  return {
    fixes: matches.length,
    byPattern: [...counts].map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count || (a.pattern < b.pattern ? -1 : 1)),
    commits: matches.slice(0, limit),
    omitted: Math.max(0, matches.length - limit),
  };
}

/** Guidelines for the convention check. Judgement calls, not measurements. */
export const FIX_CONVENTION_GUIDELINES = {
  minShare: 0.02,
  maxShare: 0.6,
  minChanges: 30,
  provenance:
    "Judgement calls, not calibrated on a corpus. A share under 2 percent means the commit messages rarely say that a change is a fix, so the patterns most likely miss them. A share over 60 percent means the patterns most likely match what is not a fix. Fewer than 30 logical changes is too few for a share to mean anything.",
} as const;

export interface FixConvention {
  logicalChanges: number;
  fixes: number;
  /** Fixes over logical changes, 3 decimals. Null with no change. */
  share: number | null;
  /** False when the share is outside the guideline or there are too few changes. */
  followsConvention: boolean;
  /** Why the commit messages probably do not follow a convention this can use. Null when they do. */
  note: string | null;
  guidelines: { minShare: number; maxShare: number; minChanges: number; provenance: string };
}

const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;

/**
 * The repository-level check that commands run before they use a fix count: the share of logical changes in the window that
 * are fixes. A share under 2% or over 60%, or fewer than 30 logical changes, says the commit messages probably do not follow
 * a convention this can use. The counts are still reported, and nothing is removed.
 */
export function checkFixConvention(logicalChanges: number, fixes: number): FixConvention {
  const { minShare, maxShare, minChanges } = FIX_CONVENTION_GUIDELINES;
  const share = logicalChanges === 0 ? null : Math.round((fixes / logicalChanges) * 1000) / 1000;
  const reasons: string[] = [];
  if (logicalChanges < minChanges) reasons.push(`there are ${logicalChanges} logical changes in the window, fewer than ${minChanges}`);
  if (share !== null && share < minShare) reasons.push(`fixes are ${percent(share)} of logical changes, under ${percent(minShare)}`);
  if (share !== null && share > maxShare) reasons.push(`fixes are ${percent(share)} of logical changes, over ${percent(maxShare)}`);
  return {
    logicalChanges,
    fixes,
    share,
    followsConvention: reasons.length === 0,
    note: reasons.length === 0 ? null : `The commit messages probably do not follow a convention this can use: ${reasons.join("; ")}.`,
    guidelines: { minShare, maxShare, minChanges, provenance: FIX_CONVENTION_GUIDELINES.provenance },
  };
}

import { existsSync } from "node:fs";
import { usageError } from "@code-health/cli-kit/errors";
import { checkouts } from "@code-health/history/checkouts";
import { analyseHistory, monthsBefore } from "@code-health/history/evidence";
import { checkFixConvention, fixEvidence, findFix, type FixClassifier, type FixConvention, type FixEvidence, type FixMatch } from "@code-health/history/fix-commits";
import { runGit } from "@code-health/history/git";
import type { LogicalChange } from "@code-health/history/noise";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef } from "@code-health/parse/source-tree";
import { measureRepo, summariseTasks, type EffortSummary } from "@code-health/transcripts/measure-repo";
import { stampOf } from "@code-health/transcripts/stamp";
import { parseWindow } from "@code-health/transcripts/time-window";
import { weightsFromChanges } from "./change-weights.ts";
import type { ComplexitySettings } from "./config.ts";
import { meanDepth } from "./interface-depth.ts";
import { measureTree, type FileRecord } from "./measure.ts";
import { rankUnits } from "./ranking.ts";

/** What the change history says about a set of files in one window. */
export interface ChangeFigures {
  /** Logical changes that touched the files. The sample every other figure here rests on. */
  changes: number;
  /** Mean lines added plus deleted in the files per such change. Null with no change. */
  linesChurnedPerChange: number | null;
  /** Share of those changes with a commit that matches the shared fix definition (`history.fixPatterns`). Null with no change. */
  fixCommitRate: number | null;
  /** The commits behind `fixCommitRate`, with the pattern that matched each. Some matches are not defects, such as "fix the bug report template". */
  fixCommits: FixEvidence;
}

/** The weighted rank of a set of files' functions at one moment. */
export interface RankFigures {
  functions: number;
  /** Mean rank score: the highest metric percentile in the repository times the change weight. Null with no function. */
  meanScore: number | null;
  /** The same before the change weight. */
  meanComplexityScore: number | null;
}

export interface ShapeFigures {
  functions: number;
  /** Mean interface depth of the exported functions and classes, per file, then over files. Null with none. */
  meanInterfaceDepth: number | null;
}

interface Group<T> {
  before: T;
  after: T;
}

export interface Outcome {
  actedOn: {
    /** The last commit of the simplification. */
    at: string;
    /** The commit before the first of it, whose code is the baseline. */
    before: string;
    files: { path: string; earlierPath: string }[];
  };
  comparison: {
    /** Candidates not acted on, matched to the acted-on files by their rank before the change. */
    files: string[];
    basis: string;
  };
  /**
   * Two windows of `windowMonths`, either side of the change. The after window stops at the analysed history's
   * end when that comes first, and `complete` says whether it ran its full length.
   */
  windows: { before: { since: string; until: string }; after: { since: string; until: string; complete: boolean } };
  /**
   * The repository-level check on the fix definition, over every logical change in the two windows. When it says the commit
   * messages probably do not follow a convention, read `fixCommitRate` with that in mind.
   */
  fixConvention: FixConvention;
  /** Primary outcome: what changing the code cost afterwards, with the fix rate beside it as the secondary one. */
  changeCost: { actedOn: Group<ChangeFigures>; comparison: Group<ChangeFigures> };
  /** Leading indicator only: the same measure the tool ranks by. */
  rank: { actedOn: Group<RankFigures>; comparison: Group<RankFigures> };
  /** Whether the simplification added functions while their interfaces got shallower. */
  gamingCheck: { actedOn: Group<ShapeFigures>; suspected: boolean };
  /** The comparison group's change subtracted from the acted-on files', so drift back to the average cancels. Null where a figure is missing. */
  difference: { linesChurnedPerChange: number | null; fixCommitRate: number | null; changes: number; meanScore: number | null };
  agentEffort:
    | { status: "measured"; actedOn: Group<EffortSummary>; comparison: Group<EffortSummary> }
    | { status: "not-measured"; reason: string };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const mean = (values: number[]): number | null => (values.length === 0 ? null : round3(values.reduce((sum, value) => sum + value, 0) / values.length));

/** The first commit of a logical change that matches the shared fix definition, from `@code-health/history/fix-commits`. */
function fixOfChange(change: LogicalChange, fix: FixClassifier, messageOf: (sha: string) => string): FixMatch | null {
  for (const sha of change.shas) {
    const found = findFix(fix, sha, [messageOf(sha)]);
    if (found !== null) return found;
  }
  return null;
}

const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

async function resolveRevision(root: string, rev: string): Promise<string> {
  try {
    return (await runGit(root, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
  } catch {
    throw usageError(`"${rev}" is not a revision of this repository`);
  }
}

/** Files changed between two commits that exist in both, by their name later and their name earlier. Added and deleted files are not acted on. */
async function changedFiles(root: string, earlier: string, later: string): Promise<{ path: string; earlierPath: string }[]> {
  const listing = await runGit(root, ["diff", "--name-status", "-M", "-z", earlier, later]);
  const fields = listing.split("\0");
  const files: { path: string; earlierPath: string }[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (status === undefined || status === "") break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i++]!;
      const to = fields[i++]!;
      if (status.startsWith("R")) files.push({ path: to, earlierPath: from });
    } else {
      const path = fields[i++]!;
      if (status === "M") files.push({ path, earlierPath: path });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function changeFigures(
  changes: readonly LogicalChange[],
  members: ReadonlySet<string>,
  fix: FixClassifier,
  messageOf: (sha: string) => string,
): ChangeFigures {
  const churn: number[] = [];
  const fixes: FixMatch[] = [];
  for (const change of changes) {
    const touched = change.files.filter((file) => members.has(file.path) || members.has(file.fileId));
    if (touched.length === 0) continue;
    churn.push(touched.reduce((sum, file) => sum + (file.added ?? 0) + (file.deleted ?? 0), 0));
    const found = fixOfChange(change, fix, messageOf);
    if (found !== null) fixes.push(found);
  }
  return {
    changes: churn.length,
    linesChurnedPerChange: mean(churn),
    fixCommitRate: churn.length === 0 ? null : round3(fixes.length / churn.length),
    fixCommits: fixEvidence(fixes),
  };
}

function shapeFigures(files: readonly FileRecord[]): ShapeFigures {
  const depths = files.flatMap((file) => {
    const depth = meanDepth(file);
    return depth === null ? [] : [depth];
  });
  return { functions: files.reduce((sum, file) => sum + file.units.length, 0), meanInterfaceDepth: mean(depths) };
}

/** The highest rank percentile of any unit of a file, which is how a file's rank is set for matching. */
function fileScores(files: readonly FileRecord[], selected: ComplexitySettings["metrics"]): Map<string, number> {
  const ranked = rankUnits(files.flatMap((file) => file.units), selected);
  const scores = new Map<string, number>();
  for (const entry of ranked) scores.set(entry.unit.path, Math.max(scores.get(entry.unit.path) ?? 0, entry.complexityScore));
  return scores;
}

/** For each acted-on file in path order, the unused candidate with the nearest rank, ties to the earlier path. */
function matchComparison(acted: readonly string[], candidates: readonly string[], scores: ReadonlyMap<string, number>): string[] {
  const free = [...candidates].sort();
  const chosen: string[] = [];
  for (const path of acted) {
    if (free.length === 0) break;
    const want = scores.get(path) ?? 0;
    let best = 0;
    for (let i = 1; i < free.length; i++) {
      if (Math.abs((scores.get(free[i]!) ?? 0) - want) < Math.abs((scores.get(free[best]!) ?? 0) - want)) best = i;
    }
    chosen.push(free.splice(best, 1)[0]!);
  }
  return chosen.sort();
}

function rankFigures(
  files: readonly FileRecord[],
  members: ReadonlySet<string>,
  selected: ComplexitySettings["metrics"],
  changes: readonly LogicalChange[],
  until: number,
  settings: ComplexitySettings,
): RankFigures {
  const weights = weightsFromChanges(changes, monthsBefore(until, settings.windowMonths), until, settings.windowMonths);
  const ranked = rankUnits(files.flatMap((file) => file.units), selected, weights).filter((entry) => members.has(entry.unit.path));
  return {
    functions: ranked.length,
    meanScore: mean(ranked.map((entry) => entry.score)),
    meanComplexityScore: mean(ranked.map((entry) => entry.complexityScore)),
  };
}

const delta = (before: number | null, after: number | null): number | null => (before === null || after === null ? null : round3(after - before));
const gap = (own: number | null, other: number | null): number | null => (own === null || other === null ? null : round3(own - other));

/**
 * The outcome instruments of a simplification: whether the code the tool acted on got cheaper to change,
 * set beside candidates of similar rank that were left alone. The simplification is the commits from
 * `from` (default `at`) to `at`; the files it changed are the acted-on files, and the baseline is the commit
 * before `from`. Windows of `windowMonths` before and after, the same filters in both, leave out the
 * simplification's own commits and every commit with a `Code-Health:` trailer.
 */
export async function measureOutcome(
  root: string,
  settings: ComplexitySettings,
  exclude: readonly string[],
  options: { at: string; from: string | undefined; projectsDir: string | undefined },
): Promise<{ outcome: Outcome; transcriptStamp: string | null }> {
  const at = await resolveRevision(root, options.at);
  const first = options.from === undefined ? at : await resolveRevision(root, options.from);
  let beforeSha: string;
  try {
    beforeSha = (await runGit(root, ["rev-parse", "--verify", `${first}^`])).trim();
  } catch {
    throw usageError(`${first} has no parent, so there is no earlier code to compare with`);
  }
  const series = new Set((await runGit(root, ["rev-list", `${beforeSha}..${at}`])).split("\n").filter((line) => line !== ""));
  if (series.size === 0 || !series.has(first)) throw usageError(`--from ${options.from} is not an ancestor of ${options.at}`);
  const date = Number((await runGit(root, ["log", "-1", "--format=%ct", at])).trim());
  const startedAt = Number((await runGit(root, ["log", "-1", "--format=%ct", first])).trim());

  const history = await analyseHistory(root, { ref: "HEAD", noise: { exclude: [...exclude], botPatterns: settings.botPatterns, maxChangesetSize: settings.maxChangesetSize, excludeSuiteCommits: true } });
  const headDate = history.view.headDate;
  // Matching windows: the after window is as long as the before window, or ends where the history does.
  const fullEnd = monthsBefore(date, -settings.windowMonths);
  const anchor = Math.min(fullEnd, headDate);
  const messages = new Map(history.view.commits.map((commit) => [commit.sha, commit.message] as const));
  const messageOf = (sha: string): string => messages.get(sha) ?? "";
  const eligible = history.filtered.changes.filter((change) => !change.shas.some((sha) => series.has(sha)));
  const beforeChanges = eligible.filter((change) => change.committerDate >= monthsBefore(date, settings.windowMonths) && change.committerDate < date);
  const afterChanges = eligible.filter((change) => change.committerDate > date && change.committerDate <= anchor);

  const cache = await ParseCache.forRepository(root);
  const selected = settings.metrics;
  const earlier = (await measureTree(await treeFromRef(root, beforeSha), { settings, layer: "auto", cache })).files;
  const later = (await measureTree(await treeFromRef(root, at), { settings, layer: "auto", cache })).files;
  const earlierBy = new Map(earlier.map((file) => [file.path, file] as const));
  const laterBy = new Map(later.map((file) => [file.path, file] as const));

  const acted = (await changedFiles(root, beforeSha, at)).filter(
    ({ path, earlierPath }) => (earlierBy.get(earlierPath)?.units.length ?? 0) > 0 || (laterBy.get(path)?.units.length ?? 0) > 0,
  );
  if (acted.length === 0) throw usageError(`no file with functions changed between ${beforeSha.slice(0, 7)} and ${at.slice(0, 7)}`);
  const actedEarlier = new Set(acted.map((file) => file.earlierPath));
  const actedLater = new Set(acted.map((file) => file.path));

  const scores = fileScores(earlier, selected);
  const candidates = earlier
    .filter((file) => file.units.length > 0 && !actedEarlier.has(file.path) && laterBy.has(file.path) && !actedLater.has(file.path))
    .map((file) => file.path);
  const control = matchComparison(
    acted.map((file) => file.earlierPath),
    candidates,
    scores,
  );
  const controlSet = new Set(control);

  const figures = (changes: readonly LogicalChange[], members: ReadonlySet<string>) => changeFigures(changes, members, settings.fix, messageOf);
  const inWindows = [...beforeChanges, ...afterChanges];
  const fixConvention = checkFixConvention(inWindows.length, inWindows.filter((change) => fixOfChange(change, settings.fix, messageOf) !== null).length);
  const changeCost: Outcome["changeCost"] = {
    actedOn: { before: figures(beforeChanges, actedEarlier), after: figures(afterChanges, actedLater) },
    comparison: { before: figures(beforeChanges, controlSet), after: figures(afterChanges, controlSet) },
  };
  const rank: Outcome["rank"] = {
    actedOn: {
      before: rankFigures(earlier, actedEarlier, selected, history.filtered.changes, date, settings),
      after: rankFigures(later, actedLater, selected, history.filtered.changes, anchor, settings),
    },
    comparison: {
      before: rankFigures(earlier, controlSet, selected, history.filtered.changes, date, settings),
      after: rankFigures(later, controlSet, selected, history.filtered.changes, anchor, settings),
    },
  };
  const shape: Group<ShapeFigures> = {
    before: shapeFigures(earlier.filter((file) => actedEarlier.has(file.path))),
    after: shapeFigures(later.filter((file) => actedLater.has(file.path))),
  };
  const suspected =
    shape.after.functions > shape.before.functions &&
    shape.before.meanInterfaceDepth !== null &&
    shape.after.meanInterfaceDepth !== null &&
    shape.after.meanInterfaceDepth < shape.before.meanInterfaceDepth;

  const groupDelta = (pick: (figures: ChangeFigures) => number | null) => {
    const own = delta(pick(changeCost.actedOn.before), pick(changeCost.actedOn.after));
    const other = delta(pick(changeCost.comparison.before), pick(changeCost.comparison.after));
    return gap(own, other);
  };
  const changesDelta = (own: Group<ChangeFigures>) => own.after.changes - own.before.changes;

  let transcriptStamp: string | null = null;
  const effort = async (): Promise<Outcome["agentEffort"]> => {
    const { projectsDir } = options;
    if (projectsDir === undefined || !existsSync(projectsDir)) {
      return { status: "not-measured", reason: projectsDir === undefined ? "no --projects-dir was given" : `${projectsDir} does not exist` };
    }
    const repoRoots = await checkouts(root);
    const measure = (from: number, to: number) => measureRepo({ projectsDir, repoRoots, window: parseWindow(day(from), day(to)) }).tasks;
    const touching = <T extends { editedPaths: string[] }>(tasks: T[], paths: ReadonlySet<string>): T[] => tasks.filter((task) => task.editedPaths.some((path) => paths.has(path)));
    // The sessions that made the simplification are neither before nor after: the before window ends where it
    // began, and the after window takes only sessions that started after its last commit.
    const beforeTasks = measure(monthsBefore(date, settings.windowMonths), startedAt).filter((task) => Date.parse(task.startedAt) < startedAt * 1000);
    const afterTasks = measure(date, anchor + 86_400).filter((task) => Date.parse(task.startedAt) > date * 1000);
    transcriptStamp = stampOf([...beforeTasks, ...afterTasks]);
    const own = { before: touching(beforeTasks, actedEarlier), after: touching(afterTasks, actedLater) };
    if (own.before.length === 0 && own.after.length === 0) return { status: "not-measured", reason: "no session in the windows edited the acted-on files" };
    return {
      status: "measured",
      actedOn: { before: summariseTasks(own.before), after: summariseTasks(own.after) },
      comparison: { before: summariseTasks(touching(beforeTasks, controlSet)), after: summariseTasks(touching(afterTasks, controlSet)) },
    };
  };

  const agentEffort = await effort();
  const outcome: Outcome = {
    actedOn: { at, before: beforeSha, files: acted },
    comparison: {
      files: control,
      basis: "unchanged files with functions, matched one to one to the acted-on files by the highest metric percentile of their functions before the change",
    },
    windows: {
      before: { since: iso(monthsBefore(date, settings.windowMonths)), until: iso(date) },
      after: { since: iso(date), until: iso(anchor), complete: fullEnd <= headDate },
    },
    fixConvention,
    changeCost,
    rank,
    gamingCheck: { actedOn: shape, suspected },
    difference: {
      linesChurnedPerChange: groupDelta((figure) => figure.linesChurnedPerChange),
      fixCommitRate: groupDelta((figure) => figure.fixCommitRate),
      changes: changesDelta(changeCost.actedOn) - changesDelta(changeCost.comparison),
      meanScore: gap(delta(rank.actedOn.before.meanScore, rank.actedOn.after.meanScore), delta(rank.comparison.before.meanScore, rank.comparison.after.meanScore)),
    },
    agentEffort,
  };
  return { outcome, transcriptStamp };
}

import { compareIds } from "@code-health/graph/graph";
import { round3 } from "../stability.ts";
import { independenceTail, recencyWeight } from "./changes.ts";
import { percent, raise, type Finding, type FindingContext } from "./findings.ts";
import type { PackageModel } from "./model.ts";

/** One package's closure, beside the share of the repository's changes it takes part in. */
export interface Closure {
  /** Eligible changes that touched the package. */
  changes: number;
  /** Its share of all eligible changes. Closure rises with it for no other reason than size. */
  share: number;
  /** Eligible changes that touched no other package, over `changes`. Null with no changes. */
  closure: number | null;
  /** Eligible changes that touched it and another package. */
  crossing: number;
  /** Packages with a comparable share of changes, itself included. */
  comparable: number;
  /** Where this closure stands among them, 0 for the least closed to 1 for the most. Null when there are too few. */
  standing: number | null;
}

/** Closure of every package, judged only against packages of comparable share. */
export function measureClosure(model: PackageModel): Map<string, Closure> {
  const { activity, settings } = model;
  const { closureBand, minComparable } = settings.packages;
  const total = activity.eligibleChanges;
  const rows = model.packages.map((pkg) => {
    const changes = activity.eligible(pkg.id);
    return { id: pkg.id, changes, share: total === 0 ? 0 : changes / total, closure: changes === 0 ? null : activity.alone(pkg.id) / changes, crossing: activity.crossing(pkg.id) };
  });
  const active = rows.filter((row) => row.changes >= settings.minRevisions && row.closure !== null);
  const result = new Map<string, Closure>();
  for (const row of rows) {
    const peers = active.filter((other) => row.share > 0 && other.share > 0 && Math.max(row.share, other.share) / Math.min(row.share, other.share) <= closureBand);
    const judged = row.changes >= settings.minRevisions && peers.length >= minComparable && peers.some((p) => p.id === row.id);
    const below = peers.filter((p) => p.closure! < row.closure!).length;
    result.set(row.id, {
      changes: row.changes,
      share: round3(row.share),
      closure: row.closure === null ? null : round3(row.closure),
      crossing: row.crossing,
      comparable: peers.length,
      standing: judged && peers.length > 1 ? round3(below / (peers.length - 1)) : null,
    });
  }
  return result;
}

/** Confidence, lift and the exact test for one ordered pair. */
export interface PairFigures {
  shared: number;
  fromChanges: number;
  toChanges: number;
  /** Share of changes to `from` that also touched `to`. */
  confidenceFromTo: number;
  confidenceToFrom: number;
  /** Confidence over the other side's base rate of change: how much more often than chance. */
  lift: number;
  /** Probability of at least this many shared changes if the two changed independently. */
  tail: number;
}

export function pairFigures(model: PackageModel, from: string, to: string): PairFigures {
  const { activity } = model;
  const shared = activity.shared(from, to);
  const a = activity.eligible(from);
  const b = activity.eligible(to);
  const total = activity.eligibleChanges;
  return {
    shared,
    fromChanges: a,
    toChanges: b,
    confidenceFromTo: a === 0 ? 0 : round3(shared / a),
    confidenceToFrom: b === 0 ? 0 : round3(shared / b),
    lift: a === 0 || b === 0 ? 0 : round3((shared * total) / (a * b)),
    tail: round3(independenceTail(shared, a, b, total)),
  };
}

const significant = (figures: PairFigures, model: PackageModel): boolean =>
  figures.shared >= model.settings.packages.minSupport && figures.lift >= model.settings.packages.minLift && figures.tail <= model.settings.packages.significance;

function lowClosure(context: FindingContext, closure: ReadonlyMap<string, Closure>): Finding[] {
  const { model } = context;
  const findings: Finding[] = [];
  const peersOf = (id: string) => {
    const mine = closure.get(id)!;
    return model.packages.filter((p) => {
      const theirs = closure.get(p.id)!;
      return theirs.closure !== null && theirs.changes >= model.settings.minRevisions && mine.share > 0 && theirs.share > 0 &&
        Math.max(mine.share, theirs.share) / Math.min(mine.share, theirs.share) <= model.settings.packages.closureBand;
    });
  };
  for (const pkg of model.packages) {
    const mine = closure.get(pkg.id)!;
    if (mine.standing === null || mine.closure === null) continue;
    const values = peersOf(pkg.id).map((p) => closure.get(p.id)!.closure!).sort((a, b) => a - b);
    const quartile = values[Math.floor((values.length - 1) / 4)]!;
    if (mine.closure > quartile || mine.closure >= values[values.length - 1]!) continue;
    findings.push(
      raise(context, "low-closure", "CCP", [pkg.id],
        `${percent(1 - mine.closure)} of the ${mine.changes} changes to ${pkg.id} also touched another package, more than most packages with a comparable share of changes`,
        { closure: mine.closure, share: mine.share, changes: mine.changes, crossing: mine.crossing, comparable: mine.comparable, quartile: round3(quartile) },
        { changeCost: context.cost.package(pkg.id) }),
    );
  }
  return findings;
}

function alwaysTogether(context: FindingContext): Finding[] {
  const { model } = context;
  const { minConfidence } = model.settings.packages;
  const findings: Finding[] = [];
  const ids = model.packages.map((p) => p.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (model.activity.shared(a, b) === 0) continue;
      const figures = pairFigures(model, a, b);
      if (!significant(figures, model) || figures.confidenceFromTo < minConfidence || figures.confidenceToFrom < minConfidence) continue;
      findings.push(
        raise(context, "always-together", "CCP", [a, b],
          `${a} and ${b} changed together in ${figures.shared} changes, ${percent(figures.confidenceFromTo)} of those to ${a} and ${percent(figures.confidenceToFrom)} of those to ${b}: one unit of change split in two`,
          { ...figures },
          { changeCost: context.cost.pair(a, b) }),
      );
    }
  }
  return findings;
}

function followers(context: FindingContext): Finding[] {
  const { model } = context;
  const { minConfidence, followerReverseConfidence } = model.settings.packages;
  const findings: Finding[] = [];
  for (const [from, targets] of model.model.graph.graph) {
    for (const to of targets) {
      if (model.activity.shared(from, to) === 0) continue;
      const figures = pairFigures(model, from, to);
      if (!significant(figures, model) || figures.confidenceFromTo < minConfidence || figures.confidenceToFrom > followerReverseConfidence) continue;
      findings.push(
        raise(context, "follower", "CCP", [from, to],
          `${percent(figures.confidenceFromTo)} of the changes to ${from} also touched ${to}, which it depends on, while only ${percent(figures.confidenceToFrom)} of the changes to ${to} touched ${from}`,
          { ...figures },
          { changeCost: context.cost.pair(from, to) }),
      );
    }
  }
  return findings;
}

function crossingUnits(context: FindingContext): Finding[] {
  const { model } = context;
  const { minSupport, crossingUnitShare, crossingUnitMargin } = model.settings.packages;
  const tallies = new Map<string, { owner: string; changes: number; partners: Map<string, number>; weighted: Map<string, number> }>();
  for (const change of model.changes) {
    if (change.oversized || change.files.length < 2) continue;
    const weight = recencyWeight(change.date, model.windowSince, model.anchor);
    for (const file of change.files) {
      let tally = tallies.get(file.path);
      if (!tally) tallies.set(file.path, (tally = { owner: file.package, changes: 0, partners: new Map(), weighted: new Map() }));
      tally.changes++;
      const seen = new Set<string>();
      for (const other of change.files) {
        if (other.path === file.path) continue;
        tally.partners.set(other.package, (tally.partners.get(other.package) ?? 0) + 1);
        if (!seen.has(other.package)) {
          seen.add(other.package);
          tally.weighted.set(other.package, (tally.weighted.get(other.package) ?? 0) + weight);
        }
      }
    }
  }
  // how entangled each package is with each other package overall, so a unit is judged against its own package
  const overall = new Map<string, Map<string, number>>();
  for (const tally of tallies.values()) {
    if (!overall.has(tally.owner)) overall.set(tally.owner, new Map());
    for (const [id, count] of tally.partners) overall.get(tally.owner)!.set(id, (overall.get(tally.owner)!.get(id) ?? 0) + count);
  }
  const findings: Finding[] = [];
  for (const [path, tally] of [...tallies].sort(([a], [b]) => compareIds(a, b))) {
    if (tally.changes < model.settings.minRevisions) continue;
    const total = [...tally.partners.values()].reduce((sum, n) => sum + n, 0);
    const own = tally.partners.get(tally.owner) ?? 0;
    const [other, count] = [...tally.partners].filter(([id]) => id !== tally.owner).sort(([ia, a], [ib, b]) => b - a || compareIds(ia, ib))[0] ?? [];
    if (other === undefined || count === undefined || count < minSupport || count <= own || count / total <= crossingUnitShare) continue;
    const ofPackage = overall.get(tally.owner)!;
    const packageShare = (ofPackage.get(other) ?? 0) / [...ofPackage.values()].reduce((sum, n) => sum + n, 0);
    if (count / total - packageShare < crossingUnitMargin) continue;
    findings.push(
      raise(context, "crossing-unit", "CCP", [tally.owner, other],
        `${path} in ${tally.owner} changes with files of ${other} (${count} of ${total} co-changed files) more than with its own package (${own})`,
        { revisions: tally.changes, partnersInOther: count, partnersInOwn: own, partners: total, share: round3(count / total), packageShare: round3(packageShare) },
        { unit: path, changeCost: tally.weighted.get(other) ?? 0 }),
    );
  }
  return findings;
}

function wideChange(context: FindingContext): Finding[] {
  const { model } = context;
  const { wideChangePackages, wideChangeShare } = model.settings.packages;
  const total = model.activity.eligibleChanges;
  if (total < model.settings.minRevisions) return [];
  const wide = model.activity.touchingAtLeast(wideChangePackages);
  const share = wide / total;
  const midpoint = model.windowSince + (model.anchor - model.windowSince) / 2;
  const half = (later: boolean) => {
    const changes = model.changes.filter((c) => !c.oversized && (c.date >= midpoint) === later);
    return changes.length === 0 ? null : round3(changes.filter((c) => c.touched.length >= wideChangePackages).length / changes.length);
  };
  const counts = new Map<string, number>();
  for (const change of model.changes) {
    if (change.oversized || change.touched.length < wideChangePackages) continue;
    for (const id of change.touched) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const mostOften = [...counts].sort(([ia, a], [ib, b]) => b - a || compareIds(ia, ib)).slice(0, 5).map(([id]) => id);
  return [
    raise(context, "wide-change", "CCP", [],
      `${wide} of ${total} changes (${percent(share)}) touched at least ${wideChangePackages} packages: the packages cut across the features`,
      { wide, changes: total, share: round3(share), packagesPerWideChange: wideChangePackages, earlierShare: half(false), laterShare: half(true), mostOften },
      { subjects: ["repository"], changeCost: context.cost.wide(wideChangePackages), ...(share >= wideChangeShare ? {} : { belowGuideline: `${percent(share)} of changes against ${percent(wideChangeShare)}` }) }),
  ];
}

/** The common closure findings, which need only the history. */
export function closureFindings(context: FindingContext): Finding[] {
  const closure = measureClosure(context.model);
  return [...lowClosure(context, closure), ...alwaysTogether(context), ...followers(context), ...crossingUnits(context), ...wideChange(context)];
}


import { existsSync } from "node:fs";
import { usageError } from "@code-health/cli-kit/errors";
import { compareIds } from "@code-health/graph/graph";
import { monthsBefore } from "@code-health/history/evidence";
import { runGit } from "@code-health/history/git";
import type { LogicalChange } from "@code-health/history/noise";
import { treeFromRef } from "@code-health/parse/source-tree";
import { measureRepo, summariseTasks, type EffortSummary } from "@code-health/transcripts/measure-repo";
import { parseWindow } from "@code-health/transcripts/time-window";
import type { StructureSettings } from "../config.ts";
import { round3 } from "../stability.ts";
import { measureAbstractness } from "./abstractness.ts";
import { structuralModel } from "./check.ts";
import type { PackageIndex } from "./discovery.ts";
import type { PackageModel } from "./model.ts";
import { analyseReuse, type ReuseAnalysis } from "./reuse.ts";

/** One window's figures for the reshaped unit, and for the packages left alone. */
export interface WindowFigures {
  /** Eligible changes that touched the unit. */
  changes: number;
  /** Mean number of packages such a change touched, the unit counted as the package or packages it is in that window. Null with no change. */
  packagesPerChange: number | null;
  /** Share of those changes that touched no package outside the unit. Null with no change. */
  closure: number | null;
}

export interface ComparedFigures extends WindowFigures {
  /** The packages left alone that were compared with: those of a comparable share of changes. */
  comparable: { packages: string[]; packagesPerChange: number | null; closure: number | null };
}

export interface ReuseFigures {
  /** Packages outside the unit that use it. */
  consumers: number;
  /** The middle consumer's share of what the unit exports. Null with no consumer. */
  medianShare: number | null;
  /** Export components that have consumers. */
  components: number;
}

export interface Outcome {
  reshaped: {
    /** The last commit of the reshaping. */
    at: string;
    /** The commit before the first of the reshaping, whose packages are the earlier structure. */
    before: string;
    kind: "merge" | "split" | "move" | "removal";
    /** The packages the reshaping replaced or changed, in the earlier structure. */
    replaced: string[];
    /** The packages it created or changed, in the later structure. */
    created: string[];
    movedFiles: number;
  };
  windows: { before: { since: string; until: string }; after: { since: string; until: string } };
  /** Merging lowers packages per change and raises closure whatever else happens, so for a merge they show that it took place. */
  byConstruction: boolean;
  before: ComparedFigures;
  after: ComparedFigures | null;
  /** The gaming check: whether the result's consumers use a falling share of it. Null where the structural layer cannot read the packages. */
  reuse: { before: ReuseFigures; after: ReuseFigures; tradedOneCostForAnother: boolean } | null;
  leading: { packages: { before: number; after: number }; medianDistance: { before: number | null; after: number | null } };
  agentEffort:
    | { status: "measured"; before: EffortSummary; after: EffortSummary; control: { before: EffortSummary; after: EffortSummary } }
    | { status: "not-measured"; reason: string };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};

const mean = (values: number[]): number | null => (values.length === 0 ? null : round3(values.reduce((sum, v) => sum + v, 0) / values.length));

/** Figures for a set of packages in one window. `groups` maps a path to the package or unit it counts as. */
function figuresFor(changes: readonly LogicalChange[], groupOf: (path: string) => string | undefined, members: ReadonlySet<string>): WindowFigures {
  const sizes: number[] = [];
  let closed = 0;
  for (const change of changes) {
    if (change.oversized) continue;
    const touched = new Set<string>();
    for (const file of change.files) {
      const group = groupOf(file.path);
      if (group !== undefined) touched.add(group);
    }
    if (![...touched].some((id) => members.has(id))) continue;
    sizes.push(touched.size);
    if ([...touched].every((id) => members.has(id))) closed++;
  }
  return { changes: sizes.length, packagesPerChange: mean(sizes), closure: sizes.length === 0 ? null : round3(closed / sizes.length) };
}

function compared(
  changes: readonly LogicalChange[],
  groupOf: (path: string) => string | undefined,
  members: ReadonlySet<string>,
  alone: readonly string[],
  band: number,
): ComparedFigures {
  const own = figuresFor(changes, groupOf, members);
  const eligible = changes.filter((c) => !c.oversized).length;
  const share = (figures: WindowFigures) => (eligible === 0 ? 0 : figures.changes / eligible);
  const others = alone.map((id) => ({ id, figures: figuresFor(changes, groupOf, new Set([id])) })).filter((o) => o.figures.changes > 0);
  const near = others.filter((o) => share(own) > 0 && Math.max(share(o.figures), share(own)) / Math.min(share(o.figures), share(own)) <= band);
  const chosen = near.length > 0 ? near : others;
  return {
    ...own,
    comparable: {
      packages: chosen.map((o) => o.id).sort(compareIds),
      packagesPerChange: median(chosen.map((o) => o.figures.packagesPerChange!)),
      closure: median(chosen.map((o) => o.figures.closure!)),
    },
  };
}

function reuseOf(reuse: ReuseAnalysis, unit: ReadonlySet<string>): ReuseFigures | null {
  const shares: number[] = [];
  const consumers = new Set<string>();
  let components = 0;
  let any = false;
  for (const id of unit) {
    const profile = reuse.profiles.get(id);
    if (!profile) continue;
    any = true;
    for (const consumer of profile.consumers) {
      if (unit.has(consumer.package)) continue;
      consumers.add(consumer.package);
      shares.push(consumer.share);
    }
    components += profile.components.filter((c) => c.consumers.some((p) => !unit.has(p))).length;
  }
  return any ? { consumers: consumers.size, medianShare: median(shares), components } : null;
}

function medianDistance(model: PackageModel, reuse: ReuseAnalysis): number | null {
  const abstractness = measureAbstractness(reuse);
  const distances: number[] = [];
  for (const [id, measured] of abstractness) {
    const instability = model.model.structural.get(id)?.instability;
    if (instability !== null && instability !== undefined) distances.push(Math.abs(measured.value + instability - 1));
  }
  const middle = median(distances);
  return middle === null ? null : round3(middle);
}

const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

export async function measureOutcome(
  root: string,
  settings: StructureSettings,
  changes: readonly LogicalChange[],
  anchor: number,
  options: { at: string; from: string | undefined; projectsDir: string | undefined },
): Promise<Outcome> {
  const resolve = async (rev: string): Promise<string> => {
    try {
      return (await runGit(root, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
    } catch {
      throw usageError(`"${rev}" is not a revision of this repository`);
    }
  };
  const at = await resolve(options.at);
  const first = options.from === undefined ? at : await resolve(options.from);
  let beforeSha: string;
  try {
    beforeSha = (await runGit(root, ["rev-parse", "--verify", `${first}^`])).trim();
  } catch {
    throw usageError(`${first} has no parent, so there is no earlier structure to compare with`);
  }
  const series = new Set((await runGit(root, ["rev-list", `${beforeSha}..${at}`])).split("\n").filter((line) => line !== ""));
  if (series.size === 0 || !series.has(first)) throw usageError(`--from ${options.from} is not an ancestor of ${options.at}`);
  const date = Number((await runGit(root, ["log", "-1", "--format=%ct", at])).trim());

  const earlier = await structuralModel(root, beforeSha, settings);
  const later = await structuralModel(root, at, settings);

  // what the reshaping replaced and created, by package id, and the files that changed package
  const earlierIds = new Set(earlier.packages.map((p) => p.id));
  const laterIds = new Set(later.packages.map((p) => p.id));
  const involved = new Set([...earlierIds].filter((id) => !laterIds.has(id)));
  for (const id of laterIds) if (!earlierIds.has(id)) involved.add(id);
  let movedFiles = 0;
  const moved = (was: string | undefined, now: string | undefined): void => {
    if (was === undefined || now === undefined || was === now) return;
    movedFiles++;
    involved.add(was);
    involved.add(now);
  };
  // a file moved into another package is a rename, and a file that kept its path may have been given a new package by a manifest
  const renames = await runGit(root, ["diff", "--name-status", "-M", beforeSha, at]);
  for (const line of renames.split("\n")) {
    const [status, from, to] = line.split("\t");
    if (status?.startsWith("R") && from !== undefined && to !== undefined) moved(earlier.index.owner(from), later.index.owner(to));
  }
  for (const path of (await treeFromRef(root, at)).files.keys()) {
    if (earlier.tree.files.has(path)) moved(earlier.index.owner(path), later.index.owner(path));
  }
  // every package involved is part of the unit in each structure it exists in, so a package that kept its
  // name and took in the files of another is measured as the pair it replaced
  const replaced = new Set([...involved].filter((id) => earlierIds.has(id)));
  const created = new Set([...involved].filter((id) => laterIds.has(id)));
  if (involved.size === 0) {
    throw usageError(`nothing was reshaped between ${beforeSha.slice(0, 7)} and ${at.slice(0, 7)}: no package was added or removed and no file changed package`);
  }
  const kind: Outcome["reshaped"]["kind"] = created.size === 0 ? "removal" : replaced.size > created.size ? "merge" : created.size > replaced.size ? "split" : "move";

  const reshape = (ids: ReadonlySet<string>, index: PackageIndex, collapse: boolean) => (path: string): string | undefined => {
    const owner = index.owner(path);
    return owner !== undefined && collapse && ids.has(owner) ? "unit" : owner;
  };
  const band = settings.packages.closureBand;
  const before = changes.filter((c) => c.committerDate >= monthsBefore(date, settings.windowMonths) && c.committerDate < date && !c.shas.some((sha) => series.has(sha)));
  const after = changes.filter((c) => c.committerDate > date && c.committerDate <= anchor && !c.shas.some((sha) => series.has(sha)));
  const aloneBefore = [...earlierIds].filter((id) => laterIds.has(id) && !involved.has(id));

  const beforeFigures = compared(before, reshape(replaced, earlier.index, true), new Set(["unit"]), aloneBefore, band);
  const afterFigures = created.size === 0 ? null : compared(after, reshape(created, later.index, false), created, aloneBefore, band);

  const earlierReuse = await analyseReuse(earlier);
  const laterReuse = await analyseReuse(later);
  const reuseBefore = reuseOf(earlierReuse, replaced);
  const reuseAfter = reuseOf(laterReuse, created);
  const traded =
    reuseBefore !== null && reuseAfter !== null && afterFigures !== null && beforeFigures.closure !== null && afterFigures.closure !== null &&
    afterFigures.closure > beforeFigures.closure && reuseBefore.medianShare !== null && reuseAfter.medianShare !== null && reuseAfter.medianShare < reuseBefore.medianShare;

  const dirsOf = (model: PackageModel, ids: ReadonlySet<string>): string[] => model.packages.filter((p) => ids.has(p.id) && p.dir !== null).map((p) => (p.dir === "." ? "" : p.dir!));
  const effort = (): Outcome["agentEffort"] => {
    const projectsDir = options.projectsDir;
    if (projectsDir === undefined || !existsSync(projectsDir)) {
      return { status: "not-measured", reason: projectsDir === undefined ? "no --projects-dir was given" : `${projectsDir} does not exist` };
    }
    const windowOf = (from: number, to: number) => parseWindow(day(from), day(to));
    const touching = <T extends { editedPaths: string[] }>(tasks: T[], dirs: string[]): T[] => tasks.filter((t) => t.editedPaths.some((p) => dirs.some((d) => d === "" || p === d || p.startsWith(`${d}/`))));
    const measure = (from: number, to: number) => measureRepo({ projectsDir, repoRoots: [root], window: windowOf(from, to) }).tasks;
    const beforeTasks = measure(monthsBefore(date, settings.windowMonths), date);
    const afterTasks = measure(date, anchor + 86_400);
    const aloneDirs = (model: PackageModel) => dirsOf(model, new Set(aloneBefore));
    const unitBefore = touching(beforeTasks, dirsOf(earlier, replaced));
    const unitAfter = touching(afterTasks, dirsOf(later, created));
    if (unitBefore.length === 0 && unitAfter.length === 0) return { status: "not-measured", reason: "no session in the windows edited the reshaped packages" };
    return {
      status: "measured",
      before: summariseTasks(unitBefore),
      after: summariseTasks(unitAfter),
      control: { before: summariseTasks(touching(beforeTasks, aloneDirs(earlier))), after: summariseTasks(touching(afterTasks, aloneDirs(later))) },
    };
  };

  return {
    reshaped: { at, before: beforeSha, kind, replaced: [...replaced].sort(compareIds), created: [...created].sort(compareIds), movedFiles },
    windows: {
      before: { since: new Date(monthsBefore(date, settings.windowMonths) * 1000).toISOString(), until: new Date(date * 1000).toISOString() },
      after: { since: new Date(date * 1000).toISOString(), until: new Date(anchor * 1000).toISOString() },
    },
    byConstruction: kind === "merge",
    before: beforeFigures,
    after: afterFigures,
    reuse: reuseBefore === null || reuseAfter === null ? null : { before: reuseBefore, after: reuseAfter, tradedOneCostForAnother: traded },
    leading: {
      packages: { before: earlier.packages.length, after: later.packages.length },
      medianDistance: { before: medianDistance(earlier, earlierReuse), after: medianDistance(later, laterReuse) },
    },
    agentEffort: effort(),
  };
}


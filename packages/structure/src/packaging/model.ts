import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { compareIds, normalise, type Graph } from "@code-health/graph/graph";
import { groupGraph } from "@code-health/graph/group";
import { compileGlobs } from "@code-health/history/glob";
import { monthsBefore } from "@code-health/history/evidence";
import { isTestPath } from "@code-health/parse/languages";
import { treeFromRef, type SourceTree } from "@code-health/parse/source-tree";
import { measureActivity } from "../activity.ts";
import type { StructureSettings } from "../config.ts";
import type { LoadedHistory } from "../history-access.ts";
import type { Model } from "../model.ts";
import type { ModuleGraph } from "../modules.ts";
import { edgeKey, loadProject, type Project } from "../project.ts";
import { changeStability, round3, type StructuralStability } from "../stability.ts";
import { measurePackages, packageChanges, type PackageActivity, type PackageChange } from "./changes.ts";
import type { DeclaredDependency, DiscoveredPackage, PackageIndex } from "./discovery.ts";
import type { PackageOverride, Purpose } from "./settings.ts";

const DAY = 86_400;

/** How one package depends on another, over every kind of evidence. */
export interface PackageEdge {
  from: string;
  to: string;
  /** The widest scope any manifest gives it: runtime beats dev. Null when no manifest declares it. */
  declared: DeclaredDependency["scope"] | null;
  /** File imports from production code in `from` to files of `to`. */
  productionImports: number;
  /** File imports that involve test code. */
  testImports: number;
}

/** Everything the packaging commands need to know about one commit's packages and their history. */
export interface PackageModel {
  headSha: string;
  /** The analysed commit's committer date, unix seconds. */
  anchor: number;
  /** Start of the analysis window, unix seconds. */
  windowSince: number;
  settings: StructureSettings;
  tree: SourceTree;
  packages: readonly DiscoveredPackage[];
  byId: ReadonlyMap<string, DiscoveredPackage>;
  index: PackageIndex;
  /** Every file of the tree that a package owns, sorted. */
  files: ReadonlyMap<string, readonly string[]>;
  project: Project;
  /** Structure's model at package level: the production graph, with manifest dependencies as edges. */
  model: Model;
  /** The production graph plus development dependencies and imports from test code. */
  development: Graph;
  edges: ReadonlyMap<string, PackageEdge>;
  /** Changes inside the window, reduced to the packages they touched. */
  changes: readonly PackageChange[];
  activity: PackageActivity;
  /** When each package first appeared in the whole usable history, unix seconds. */
  firstSeen: ReadonlyMap<string, number>;
  /** Production files of each package that a language adapter reads: where the structural layer has something to say. */
  codeFiles: ReadonlyMap<string, readonly string[]>;
}

export function overrideOf(model: Pick<PackageModel, "settings">, pkg: DiscoveredPackage): PackageOverride {
  const byPackage = model.settings.packages.byPackage;
  return byPackage.get(pkg.id) ?? byPackage.get(pkg.name) ?? {};
}

/** Internal when the manifest or the config says so. Where neither does, published, which is the safe mistake. */
export function isPublished(model: Pick<PackageModel, "settings">, pkg: DiscoveredPackage): boolean {
  return overrideOf(model, pkg).published ?? pkg.private !== true;
}

export function purposeOf(model: Pick<PackageModel, "settings">, pkg: DiscoveredPackage): Purpose | null {
  return overrideOf(model, pkg).purpose ?? null;
}

/** True while a package is inside the grace period, so what it shows about reuse is tentative. */
export function isYoung(model: PackageModel, id: string): boolean {
  const first = model.firstSeen.get(id);
  return first === undefined ? true : model.anchor - first < model.settings.packages.graceDays * DAY;
}

export async function buildPackageModel(context: CommandContext, history: LoadedHistory): Promise<PackageModel> {
  const { settings } = history;
  const root = context.repo.root;
  const headSha = history.view.headSha;
  const tree = await treeFromRef(root, headSha);
  return assemblePackageModel(headSha, history, tree, await loadProject(root, headSha, settings));
}

/** Builds the model for a commit whose tree and project are already read. The project holds the packages and who owns each file. */
export function assemblePackageModel(
  headSha: string,
  history: Pick<LoadedHistory, "settings" | "filtered" | "window">,
  tree: SourceTree,
  project: Project,
): PackageModel {
  const { settings } = history;
  const { packages } = project;
  const index = project.packageIndex;
  const excluded = compileGlobs(settings.exclude);
  const byId = new Map(packages.map((p) => [p.id, p]));

  const files = new Map<string, string[]>(packages.map((p) => [p.id, []]));
  for (const path of tree.files.keys()) {
    if (excluded(path)) continue;
    const owner = index.owner(path);
    if (owner !== undefined) files.get(owner)!.push(path);
  }
  const codeFiles = new Map<string, string[]>(packages.map((p) => [p.id, []]));
  for (const path of project.files) {
    const owner = index.owner(path);
    if (owner !== undefined) codeFiles.get(owner)!.push(path);
  }

  // edges: manifests first, then imports
  const edges = new Map<string, PackageEdge>();
  const edgeFor = (from: string, to: string): PackageEdge => {
    const key = edgeKey(from, to);
    let edge = edges.get(key);
    if (!edge) edges.set(key, (edge = { from, to, declared: null, productionImports: 0, testImports: 0 }));
    return edge;
  };
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      if (dependency.target === null) continue;
      const edge = edgeFor(pkg.id, dependency.target);
      if (edge.declared !== "runtime") edge.declared = dependency.scope;
    }
  }
  for (const imported of project.analysis.importEdges) {
    if (imported.pairing === true || excluded(imported.from) || excluded(imported.to)) continue;
    const from = index.owner(imported.from);
    const to = index.owner(imported.to);
    if (from === undefined || to === undefined || from === to) continue;
    const edge = edgeFor(from, to);
    if (isTestPath(imported.from) || isTestPath(imported.to)) edge.testImports++;
    else edge.productionImports++;
  }

  const production = new Map<string, string[]>(packages.map((p) => [p.id, []]));
  const development = new Map<string, string[]>(packages.map((p) => [p.id, []]));
  for (const edge of edges.values()) {
    development.get(edge.from)!.push(edge.to);
    if (edge.declared === "runtime" || edge.productionImports > 0) production.get(edge.from)!.push(edge.to);
  }

  // The file-level members behind each package edge come from the production import graph.
  const grouped = groupGraph(project.graph, (path) => index.owner(path));
  const moduleByFile = new Map<string, string>();
  for (const [id, list] of files) for (const path of list) moduleByFile.set(path, id);
  const graph: ModuleGraph = {
    level: "package",
    moduleOf: (path) => index.owner(path),
    filesOf: files,
    moduleByFile,
    graph: normalise(production),
    members: grouped.members,
  };

  // History: the whole usable history gives each package's age, the window gives everything else.
  const anchor = history.window.until;
  const windowSince = monthsBefore(anchor, settings.windowMonths);
  const all = packageChanges(history.filtered.changes, (fileId) => moduleByFile.get(fileId));
  const firstSeen = new Map<string, number>();
  for (const change of all) {
    for (const id of change.touched) if (!firstSeen.has(id) || change.date < firstSeen.get(id)!) firstSeen.set(id, change.date);
  }
  const windowed = history.filtered.changes.filter((change) => change.committerDate >= windowSince);
  const changes = packageChanges(windowed, (fileId) => moduleByFile.get(fileId));
  const activity = measureActivity(windowed, graph, [...graph.graph].flatMap(([from, targets]) => targets.map((to): [string, string] => [from, to])));

  const model: Model = {
    project,
    graph,
    activity,
    structural: packageStability(graph.graph),
    change: changeStability(graph, activity, settings),
    locality: undefined,
  };

  return {
    headSha,
    anchor,
    windowSince,
    settings,
    tree,
    packages,
    byId,
    index,
    files,
    project,
    model,
    development: normalise(development),
    edges,
    changes,
    activity: measurePackages(changes),
    firstSeen,
    codeFiles,
  };
}

/** Martin's figures over package dependencies: how many packages depend on each, and on how many it depends. */
export function packageStability(graph: Graph): Map<string, StructuralStability> {
  const dependants = new Map<string, number>();
  for (const [, targets] of graph) for (const to of targets) dependants.set(to, (dependants.get(to) ?? 0) + 1);
  return new Map(
    [...graph].map(([id, targets]) => {
      const ca = dependants.get(id) ?? 0;
      const ce = targets.length;
      return [id, { ca, ce, instability: ca + ce === 0 ? null : round3(ce / (ca + ce)) }];
    }),
  );
}

/**
 * Packages that really use `id`: those importing it from production code, and, for packages with no
 * code for the structural layer to read, those declaring a runtime dependency on it.
 * A dependency that is declared and never used does not make a consumer.
 */
export function consumerPackages(model: PackageModel, id: string): string[] {
  const out: string[] = [];
  for (const edge of model.edges.values()) {
    if (edge.to !== id) continue;
    const unread = (model.codeFiles.get(edge.from)?.length ?? 0) === 0;
    if (edge.productionImports > 0 || (edge.declared === "runtime" && unread)) out.push(edge.from);
  }
  return out.sort(compareIds);
}

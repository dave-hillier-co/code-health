import { dominatorUnits } from "@code-health/graph/dominator-units";
import { compareIds, reachableFrom, subgraph, type Graph } from "@code-health/graph/graph";
import { stronglyConnectedComponents } from "@code-health/graph/scc";
import { siblingSetUnits } from "@code-health/graph/sibling-units";
import { folderOf } from "@code-health/graph/tree-distance";
import { compileGlobs } from "@code-health/history/glob";
import type { LocalitySettings } from "./config.ts";
import { pairing, type History } from "./history-evidence.ts";
import type { Project } from "./project.ts";

/** The virtual root that imports every production entry point. It cannot be a path. */
export const ROOT = "\0root";

/** A production file depending on another, with barrels followed through to the definition. */
export interface Edge {
  from: string;
  to: string;
  /** Uses of the dependency, at least 1 so an import with no references still counts. */
  weight: number;
  calls: number;
  references: number;
}

export interface RawUnit {
  kind: "file" | "branch" | "sibling-set";
  /** What the unit is called in results: its entry file, or for a sibling set its folder. */
  path: string;
  /** The file that names the unit: its entry, or the first entry of a sibling set. */
  root: string;
  /** Entry files of a sibling set. */
  entries: string[];
  /** Every file that moves with the unit, sorted. */
  files: string[];
  /** True when the unit contains an import cycle, which can only move whole. */
  cycle: boolean;
}

export interface Model {
  entries: ReadonlySet<string>;
  entrySource: "config" | "detected";
  /** Files the virtual root cannot reach: dead code, or an entry point missing from config. */
  unreachable: string[];
  reachable: ReadonlySet<string>;
  edges: Edge[];
  incoming: ReadonlyMap<string, Edge[]>;
  outgoing: ReadonlyMap<string, Edge[]>;
  /** Production files that import each file, barrels included. */
  importers: ReadonlyMap<string, string[]>;
  units: RawUnit[];
}

function addToList<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The production entry files: the configured globs, or the files nothing in production imports. */
function chooseEntries(
  production: readonly string[],
  imports: ReadonlyMap<string, readonly string[]>,
  settings: LocalitySettings,
): { entries: Set<string>; source: "config" | "detected" } {
  if (settings.entryPoints.length > 0) {
    const matches = compileGlobs(settings.entryPoints);
    return { entries: new Set(production.filter((path) => matches(path))), source: "config" };
  }
  const imported = new Set<string>();
  for (const [from, targets] of imports) for (const to of targets) if (to !== from) imported.add(to);
  const entries = new Set(production.filter((path) => !imported.has(path)));
  // A cycle nothing outside it imports has no entry of its own: its first file stands for it.
  const covered = reachableFrom(imports, entries);
  for (const path of production) {
    if (covered.has(path)) continue;
    entries.add(path);
    for (const reached of reachableFrom(imports, [path])) covered.add(reached);
  }
  return { entries, source: "detected" };
}

/** The production dependency graph, the virtual root, and the units found in it. */
export function buildModel(project: Project, settings: LocalitySettings, history?: History): Model {
  const { analysis, production, isTest } = project;
  const productionSet = new Set(production);
  const importSets = new Map<string, Set<string>>(production.map((path) => [path, new Set()]));
  const importers = new Map<string, string[]>();
  // A statement whose edge runs on to a definition (Rust) also imports the file its path names, which is `via`.
  const imported = (from: string, to: string): void => {
    if (from === to || !productionSet.has(to) || importSets.get(from)!.has(to)) return;
    importSets.get(from)!.add(to);
    addToList(importers, to, from);
  };
  for (const edge of analysis.importEdges) {
    if (edge.from === edge.to || !productionSet.has(edge.from) || !productionSet.has(edge.to)) continue;
    if (edge.via !== undefined) imported(edge.from, edge.via);
    imported(edge.from, edge.to);
  }
  const imports = new Map([...importSets].map(([from, targets]): [string, string[]] => [from, [...targets].sort(compareIds)]));
  for (const list of importers.values()) list.sort(compareIds);

  const { entries, source } = chooseEntries(production, imports, settings);
  const graph: Graph = new Map<string, string[]>([[ROOT, [...entries].sort(compareIds)], ...imports]);
  const reachable = reachableFrom(graph, [ROOT]);
  reachable.delete(ROOT);

  const pairs = new Map<string, Edge>();
  const pair = (from: string, to: string): Edge | undefined => {
    if (from === to || isTest(from) || !productionSet.has(from) || !productionSet.has(to)) return undefined;
    const key = `${from}\0${to}`;
    let edge = pairs.get(key);
    if (!edge) {
      edge = { from, to, weight: 1, calls: 0, references: 0 };
      pairs.set(key, edge);
    }
    return edge;
  };
  for (const fileEdge of analysis.fileEdges) {
    const edge = pair(fileEdge.from, fileEdge.to);
    if (!edge) continue;
    edge.calls = fileEdge.calls;
    edge.references = fileEdge.references;
    edge.weight = Math.max(1, fileEdge.calls + fileEdge.references);
  }
  for (const importEdge of analysis.importEdges) if (importEdge.kind === "reexport") pair(importEdge.from, importEdge.to);
  const edges = [...pairs.values()].sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));
  // Net distance counts an edge by its uses, raised by the logical changes the two files shared: files that
  // change together are pulled together, and a dependency nothing else moves with is not.
  if (history !== undefined) for (const edge of edges) edge.weight += pairing(history, new Set([edge.from]), edge.to).support;
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    addToList(incoming, edge.to, edge);
    addToList(outgoing, edge.from, edge);
  }

  return {
    entries,
    entrySource: source,
    unreachable: production.filter((path) => !reachable.has(path)),
    reachable,
    edges,
    incoming,
    outgoing,
    importers,
    units: findUnits(graph, entries),
  };
}

function inCycle(graph: Graph, files: readonly string[]): boolean {
  return stronglyConnectedComponents(subgraph(graph, new Set(files))).some((component) => component.length > 1);
}

function findUnits(graph: Graph, entries: ReadonlySet<string>): RawUnit[] {
  const units: RawUnit[] = [];
  const dominated = dominatorUnits(graph, ROOT);
  for (const [root, files] of dominated.units) {
    if (files.some((file) => entries.has(file))) continue;
    units.push({
      kind: files.length === 1 ? "file" : "branch",
      path: root,
      root,
      entries: [],
      files: [...files],
      cycle: inCycle(graph, files),
    });
  }
  for (const set of siblingSetUnits(graph, ROOT, folderOf)) {
    if (set.files.some((file) => entries.has(file))) continue;
    // A set is a unit of its own only when its entries share internals: a file that no single entry dominates.
    // Otherwise each entry's own unit already covers everything the set would move.
    const covered = new Set(set.entries.flatMap((entry) => dominated.units.get(entry) ?? [entry]));
    if (set.files.every((file) => covered.has(file))) continue;
    units.push({
      kind: "sibling-set",
      path: set.folder,
      root: set.entries[0] as string,
      entries: [...set.entries],
      files: [...set.files],
      cycle: false,
    });
  }
  return units.sort((a, b) => compareIds(a.path, b.path));
}

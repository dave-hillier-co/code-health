import { breakingSets } from "@code-health/graph/feedback-arc-set";
import { compareIds } from "@code-health/graph/graph";
import type { StructureSettings } from "./config.ts";
import type { Model } from "./model.ts";
import { buildModuleGraph, describeEdge, importGraph, type EdgeDetail, type ModuleGraph } from "./modules.ts";
import { edgeKey, type Project } from "./project.ts";
import type { Unblock } from "./locality-report.ts";

/** At most this many symbols are listed per breaking edge in a cycle row. `evidence` lists them all. */
export const SYMBOLS_SHOWN = 10;

export interface BreakingEdge {
  from: string;
  to: string;
  /** Eligible logical changes that touched both sides. */
  coChange: number;
  fileEdges: number;
  importStatements: number;
  typeOnly: boolean;
  symbolsTotal: number;
  symbols: { symbol: string; sites: number; kind: "call" | "reference" }[];
  /** Moves locality reports as held back by this dependency. Empty without a matching locality report. */
  unblocks: Unblock[];
}

export interface CycleRow {
  id: string;
  level: string;
  size: number;
  nodes: string[];
  /** A folder cycle whose folders all lie on one path from the root, such as a folder and its child. Always false at other levels. Listed after cycles that are not nested. */
  nested: boolean;
  method: "exact" | "heuristic";
  breakingSet: BreakingEdge[];
  /** Eligible logical changes touching two modules of the cycle that depend on each other, each pair counted once. */
  coChangeAcross: number;
  /** Sum of the unblocked gain of every move the breaking set would free, or null without a locality report. */
  unblockedGain: number | null;
}

const isAncestorFolder = (ancestor: string, folder: string): boolean => ancestor === "." || folder.startsWith(`${ancestor}/`);

/** Whether every folder is an ancestor or a descendant of every other. */
export function isNestedFolderCycle(level: string, nodes: readonly string[]): boolean {
  if (level !== "folder") return false;
  return nodes.every((a) => nodes.every((b) => a === b || isAncestorFolder(a, b) || isAncestorFolder(b, a)));
}

export const cycleId = (level: string, firstNode: string): string => `cycle:${level}:${firstNode}`;

export function unblocksOf(model: Model, from: string, to: string): Unblock[] {
  if (!model.locality) return [];
  const members = model.graph.members.get(edgeKey(from, to)) ?? [];
  return members.flatMap((edge) => model.locality!.byFileEdge.get(edgeKey(edge.from, edge.to)) ?? []);
}

export function breakingEdge(model: Model, from: string, to: string, limit = SYMBOLS_SHOWN): BreakingEdge {
  const detail: EdgeDetail = describeEdge(model.project, model.graph, from, to);
  return {
    from,
    to,
    coChange: model.activity.shared(from, to),
    fileEdges: detail.fileEdges,
    importStatements: detail.importStatements,
    typeOnly: detail.typeOnly,
    symbolsTotal: detail.symbols.length,
    symbols: detail.symbols.slice(0, limit).map(({ symbol, sites, kind }) => ({ symbol, sites, kind })),
    unblocks: unblocksOf(model, from, to),
  };
}

/**
 * Every import cycle at the model's level with its breaking set, nested folder cycles last, then ranked by the locality gain the
 * breaking set unblocks (when a locality report is present), then by the size of the cycle, then
 * by co-change across it, then by id. Breaking-set ties go to the edge whose sides co-change least.
 */
export function findCycles(model: Model, settings: Pick<StructureSettings, "exactLimit">): CycleRow[] {
  const graph = importGraph(model.graph);
  const files = new Set(model.project.files);
  const sets = breakingSets(graph, {
    exactLimit: settings.exactLimit,
    weight: (edge) => model.activity.shared(edge.from, edge.to),
  });
  const rows = sets.map((cycle): CycleRow => {
    const inCycle = new Set(cycle.nodes);
    let coChangeAcross = 0;
    for (const from of cycle.nodes) {
      for (const to of graph.get(from) ?? []) {
        // a pair that depends on each other both ways is one pair
        if (inCycle.has(to) && (compareIds(from, to) < 0 || !graph.get(to)?.includes(from))) {
          coChangeAcross += model.activity.shared(from, to);
        }
      }
    }
    const breakingSet = cycle.edges.map((edge) => breakingEdge(model, edge.from, edge.to));
    return {
      id: cycleId(model.graph.level, cycle.nodes[0]!),
      level: model.graph.level,
      size: cycle.nodes.length,
      nodes: [...cycle.nodes],
      nested: isNestedFolderCycle(model.graph.level === "default" && cycle.nodes.every((node) => !files.has(node)) ? "folder" : model.graph.level, cycle.nodes),
      method: cycle.method,
      breakingSet,
      coChangeAcross,
      unblockedGain: model.locality ? breakingSet.reduce((sum, edge) => sum + edge.unblocks.reduce((s, u) => s + u.unblockedGain, 0), 0) : null,
    };
  });
  return rows.sort(
    (a, b) =>
      Number(a.nested) - Number(b.nested) || (b.unblockedGain ?? 0) - (a.unblockedGain ?? 0) || b.size - a.size || b.coChangeAcross - a.coChangeAcross || compareIds(a.id, b.id),
  );
}

/** At most this many folder cycles inside C# projects are listed, the largest first. The count is of all of them. */
export const PROJECT_FOLDER_CYCLES_SHOWN = 3;

/**
 * The project that holds every folder of a folder cycle when all their files are C#, or undefined. Folders of one project are one
 * compilation unit and one namespace tree, so a cycle among them is not a dependency between separate parts.
 */
export function csharpProjectOfFolders(project: Project, graph: ModuleGraph, nodes: readonly string[]): string | undefined {
  const files = nodes.flatMap((node) => graph.filesOf.get(node) ?? []);
  if (files.length === 0 || !files.every((file) => file.endsWith(".cs"))) return undefined;
  const owners = new Set(files.map((file) => project.packageOf(file)));
  return owners.size === 1 ? [...owners][0] : undefined;
}

export interface ProjectFolderCycles {
  count: number;
  largest: { id: string; size: number; nodes: string[]; project: string }[];
}

/** The folder cycles whose folders are all C# folders of one project: how many there are, and the largest few. */
export function findProjectFolderCycles(project: Project, settings: Pick<StructureSettings, "exactLimit" | "components">): ProjectFolderCycles {
  const graph = buildModuleGraph("folder", project, settings.components);
  const inside = breakingSets(importGraph(graph), { exactLimit: settings.exactLimit }).flatMap((cycle) => {
    const owner = csharpProjectOfFolders(project, graph, cycle.nodes);
    return owner === undefined ? [] : [{ id: cycleId("folder", cycle.nodes[0]!), size: cycle.nodes.length, nodes: [...cycle.nodes], project: owner }];
  });
  inside.sort((a, b) => b.size - a.size || compareIds(a.id, b.id));
  return { count: inside.length, largest: inside.slice(0, PROJECT_FOLDER_CYCLES_SHOWN) };
}

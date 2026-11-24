import { condense, type Condensation } from "@code-health/graph/scc";
import { compareIds, type Graph } from "@code-health/graph/graph";
import { adapterForPath } from "@code-health/parse/languages";
import type { CycleRow } from "./cycles.ts";
import type { LayerViolation } from "./layers.ts";
import { edgeKey } from "./project.ts";
import type { ModuleGraph } from "./modules.ts";

/** At most this many modules are drawn in the dependency structure matrix. */
export const DSM_MODULES = 25;

export interface DsmGroup {
  /** `cycle N`, where N is the cycle's place in the cycles list. */
  label: string;
  /** First and last drawn row of the group. */
  start: number;
  end: number;
  /** Modules of the cycle, drawn or not. */
  size: number;
}

/**
 * The module dependency structure matrix of one language at the default level: the drawn modules in layer order, and for each
 * pair the number of file imports of the row module in the column module.
 */
export interface Dsm {
  /** The language drawn, the one with the most modules. */
  language: string;
  /** Every language that has modules, with its module count, most modules first. */
  languages: { language: string; modules: number }[];
  /** Modules of the drawn language. */
  totalModules: number;
  /** Modules of the drawn language that are in a cycle. */
  cycleModules: number;
  /** Modules of the drawn language that import or are imported by another module of it. */
  connectedModules: number;
  /** Drawn modules, dependents first. */
  modules: string[];
  /** `cells[row][column]`: file imports from the row module into the column module, or null. */
  cells: (number | null)[][];
  /** Drawn cells whose dependency points against the order (below the diagonal), as [row, column]. */
  againstOrder: [number, number][];
  /** Drawn cells that hold at least one import the layer rules forbid. Empty when no layers are configured. */
  layerViolations: [number, number][];
  groups: DsmGroup[];
}

const languageOf = (graph: ModuleGraph, module: string): string => {
  const file = graph.filesOf.get(module)?.[0] ?? module;
  return adapterForPath(file)?.id ?? "other";
};

/** Layer of each component: 0 when nothing depends on it, else one more than the deepest component that depends on it. */
function layersOf(condensation: Condensation): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const id of condensation.graph.keys()) dependents.set(id, []);
  for (const [from, targets] of condensation.graph) for (const to of targets) dependents.get(to)!.push(from);
  const layer = new Map<string, number>();
  for (const start of condensation.graph.keys()) {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack[stack.length - 1]!;
      if (layer.has(id)) {
        stack.pop();
        continue;
      }
      const pending = dependents.get(id)!.filter((d) => !layer.has(d));
      if (pending.length > 0) {
        stack.push(...pending);
        continue;
      }
      layer.set(id, Math.max(-1, ...dependents.get(id)!.map((d) => layer.get(d)!)) + 1);
      stack.pop();
    }
  }
  return layer;
}

/** The members of one cycle in an order where only the edges of its breaking set point backwards. */
function orderCycle(members: readonly string[], graph: Graph, row: CycleRow | undefined): string[] {
  const broken = new Set((row?.breakingSet ?? []).map((edge) => edgeKey(edge.from, edge.to)));
  const inside = new Set(members);
  const kept = new Map<string, string[]>(members.map((m) => [m, (graph.get(m) ?? []).filter((to) => inside.has(to) && !broken.has(edgeKey(m, to)))]));
  const incoming = new Map<string, number>(members.map((m) => [m, 0]));
  for (const targets of kept.values()) for (const to of targets) incoming.set(to, incoming.get(to)! + 1);
  const ready = members.filter((m) => incoming.get(m) === 0).sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const to of kept.get(next)!) {
      incoming.set(to, incoming.get(to)! - 1);
      if (incoming.get(to) === 0) ready.push(to);
    }
    ready.sort(compareIds);
  }
  // Members left over (a cycle without a breaking set, or one that stays cyclic) follow in path order.
  const placed = new Set(order);
  return [...order, ...members.filter((m) => !placed.has(m)).sort(compareIds)];
}

/**
 * The matrix for the language with the most modules, or undefined when no module of it depends on another.
 * Modules are in layer order: a module comes after every module that depends on it, and the members of one cycle stay together with
 * only the edges of the cycle's breaking set against the order. At most `limit` modules are drawn: the members of cycles first, in
 * the order of the cycles list, then the modules with the most neighbours.
 */
export function buildDsm(graph: ModuleGraph, cycles: readonly CycleRow[], layerViolations: readonly LayerViolation[], limit = DSM_MODULES): Dsm | undefined {
  const counts = new Map<string, number>();
  const languageOfModule = new Map<string, string>();
  for (const module of graph.graph.keys()) {
    const language = languageOf(graph, module);
    languageOfModule.set(module, language);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts].map(([language, modules]) => ({ language, modules })).sort((a, b) => b.modules - a.modules || compareIds(a.language, b.language));
  const chosen = languages[0]?.language;
  if (chosen === undefined) return undefined;
  const mine = new Set([...graph.graph.keys()].filter((m) => languageOfModule.get(m) === chosen));
  const sub = new Map<string, string[]>([...mine].map((m) => [m, (graph.graph.get(m) ?? []).filter((to) => mine.has(to))]));
  const degree = new Map<string, number>([...mine].map((m) => [m, sub.get(m)!.length]));
  for (const targets of sub.values()) for (const to of targets) degree.set(to, degree.get(to)! + 1);
  const connected = [...mine].filter((m) => degree.get(m)! > 0);
  if (connected.length === 0) return undefined;

  const condensation = condense(sub);
  const layer = layersOf(condensation);
  const cycleRank = (module: string) => cycles.findIndex((row) => row.nodes.includes(module));
  const components = [...condensation.members].map(([id, members]) => ({ id, members, layer: layer.get(id)! })).sort((a, b) => a.layer - b.layer || compareIds(a.id, b.id));
  const ordered = components.flatMap((c) => (c.members.length > 1 ? orderCycle(c.members, sub, cycles[cycleRank(c.id)]) : [...c.members]));

  const inCycle = new Set(components.filter((c) => c.members.length > 1).flatMap((c) => c.members));
  const rankOf = (m: string) => (inCycle.has(m) ? (cycleRank(m) < 0 ? cycles.length : cycleRank(m)) : Number.POSITIVE_INFINITY);
  const byInterest = [...connected].sort((a, b) => rankOf(a) - rankOf(b) || degree.get(b)! - degree.get(a)! || compareIds(a, b));
  const drawn = new Set(byInterest.slice(0, limit));
  const modules = ordered.filter((m) => drawn.has(m));
  const index = new Map(modules.map((m, i) => [m, i]));

  const cells = modules.map((from) => modules.map((to): number | null => graph.members.get(edgeKey(from, to))?.length ?? null));
  const againstOrder: [number, number][] = [];
  cells.forEach((row, i) => row.forEach((value, j) => value !== null && j < i && againstOrder.push([i, j])));
  const layerCells = new Map<string, [number, number]>();
  for (const violation of layerViolations) {
    const from = graph.moduleByFile.get(violation.from);
    const to = graph.moduleByFile.get(violation.to);
    const i = from === undefined ? undefined : index.get(from);
    const j = to === undefined ? undefined : index.get(to);
    if (i !== undefined && j !== undefined && i !== j) layerCells.set(`${i},${j}`, [i, j]);
  }
  const groups = components
    .filter((c) => c.members.length > 1)
    .flatMap((c): DsmGroup[] => {
      const rows = c.members.map((m) => index.get(m)).filter((i): i is number => i !== undefined);
      if (rows.length < 2) return [];
      const rank = cycleRank(c.id);
      return [{ label: rank < 0 ? `cycle of ${c.members.length} modules` : `cycle ${rank + 1}`, start: Math.min(...rows), end: Math.max(...rows), size: c.members.length }];
    });
  return {
    language: chosen,
    languages,
    totalModules: mine.size,
    cycleModules: inCycle.size,
    connectedModules: connected.length,
    modules,
    cells,
    againstOrder,
    layerViolations: [...layerCells.values()],
    groups,
  };
}

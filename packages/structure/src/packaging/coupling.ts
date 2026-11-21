import { compareIds, subgraph, type Graph } from "@code-health/graph/graph";
import { stronglyConnectedComponents } from "@code-health/graph/scc";
import { findCycles } from "../cycles.ts";
import { findUnstableDependencies } from "../unstable.ts";
import { edgeKey } from "../project.ts";
import { raise, type Finding, type FindingContext } from "./findings.ts";

const edgeList = (edges: readonly { from: string; to: string }[]): string[] => edges.map((e) => `${e.from}->${e.to}`);

/** Each unordered pair of packages that depend on each other somewhere in `nodes`, once, for costing a cycle. */
function pairsWithin(graph: Graph, nodes: readonly string[]): [string, string][] {
  const inside = new Set(nodes);
  const pairs = new Map<string, [string, string]>();
  for (const from of nodes) {
    for (const to of graph.get(from) ?? []) {
      if (!inside.has(to) || from === to) continue;
      const [a, b] = compareIds(from, to) < 0 ? [from, to] : [to, from];
      pairs.set(`${a}\0${b}`, [a, b]);
    }
  }
  return [...pairs.values()];
}

/** Cycles in the package graph the build sees, with the smallest set of dependencies whose removal breaks each. */
export function packageCycles(context: FindingContext): Finding[] {
  const { model, cost } = context;
  return findCycles(model.model, model.settings).map((cycle) => {
    const changeCost = pairsWithin(model.model.graph.graph, cycle.nodes).reduce((sum, [a, b]) => sum + cost.pair(a, b), 0);
    const symbols = cycle.breakingSet.reduce((sum, edge) => sum + edge.symbolsTotal, 0);
    return raise(
      context,
      "package-cycle",
      "ADP",
      [...cycle.nodes],
      `${cycle.nodes.length} packages depend on each other in a cycle; cutting ${edgeList(cycle.breakingSet).join(" and ")} breaks it` +
        (symbols > 0 ? `, which means moving ${symbols} symbol${symbols === 1 ? "" : "s"}` : ""),
      {
        size: cycle.size,
        method: cycle.method,
        breakingSet: edgeList(cycle.breakingSet),
        symbolsAcross: symbols,
        coChangeAcross: cycle.coChangeAcross,
      },
      { subjects: [cycle.nodes[0]!], changeCost },
    );
  });
}

/**
 * The build forbids a cycle in the dependencies it sees, so it moves to where the build does not look:
 * development dependencies, and imports from test code. A component of the graph with those added that is
 * not already one cycle of production dependencies is a hidden cycle. One that exists through test code
 * alone is raised at low priority.
 */
export function hiddenCycles(context: FindingContext): Finding[] {
  const { model, cost } = context;
  const production = model.model.graph.graph;
  const together = new Map<string, number>();
  stronglyConnectedComponents(production).forEach((component, i) => {
    if (component.length > 1) for (const id of component) together.set(id, i);
  });
  const findings: Finding[] = [];
  for (const component of stronglyConnectedComponents(model.development)) {
    if (component.length < 2) continue;
    const inCycleAlready = component.every((id) => together.has(id) && together.get(id) === together.get(component[0]!));
    if (inCycleAlready) continue;
    const induced = subgraph(model.development, new Set(component));
    const added: { from: string; to: string; via: "development-dependency" | "test-import" }[] = [];
    for (const [from, targets] of induced) {
      for (const to of targets) {
        const edge = model.edges.get(edgeKey(from, to))!;
        const inProduction = production.get(from)?.includes(to) ?? false;
        if (inProduction) continue;
        added.push({ from, to, via: edge.declared === "dev" ? "development-dependency" : "test-import" });
      }
    }
    const testOnly = added.every((a) => a.via === "test-import");
    const changeCost = pairsWithin(induced, component).reduce((sum, [a, b]) => sum + cost.pair(a, b), 0);
    findings.push(
      raise(
        context,
        "hidden-cycle",
        "ADP",
        component,
        testOnly
          ? `${component.join(", ")} form a cycle only through imports from test code`
          : `${component.join(", ")} form a cycle that only exists through ${added.map((a) => `${a.from}->${a.to} (${a.via})`).join(", ")}`,
        { size: component.length, via: added.map((a) => `${a.from}->${a.to}:${a.via}`), testOnly },
        { subjects: [component[0]!], changeCost, priority: testOnly ? "low" : "normal" },
      ),
    );
  }
  return findings;
}

/** Dependencies from a package onto one that changes more often than it does. */
export function againstStability(context: FindingContext): Finding[] {
  const { model, cost } = context;
  return findUnstableDependencies(model.model, model.settings).map((row) =>
    raise(
      context,
      "against-stability",
      "SDP",
      [row.from, row.to],
      row.basis === "change"
        ? `${row.from} depends on ${row.to}, which changes ${row.volatilityRatio === null ? "while it does not change at all" : `${row.volatilityRatio} times as often per file`}`
        : `${row.from} depends on ${row.to}, which is less stable by its dependencies`,
      {
        basis: row.basis,
        volatilityRatio: row.volatilityRatio,
        dependantRevisionsPerFile: row.stability.from.change.revisionsPerFile,
        dependencyRevisionsPerFile: row.stability.to.change.revisionsPerFile,
        dependantInstability: row.stability.from.structural.instability,
        dependencyInstability: row.stability.to.structural.instability,
        disagree: row.disagree,
      },
      { changeCost: cost.pair(row.from, row.to) },
    ),
  );
}

/** The package cycles, stability against change, and (once abstractness is known) the zones. */
export function couplingFindings(context: FindingContext): Finding[] {
  return [...packageCycles(context), ...hiddenCycles(context), ...againstStability(context)];
}

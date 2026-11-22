import { compareIds, subgraph, type Graph } from "@code-health/graph/graph";
import { stronglyConnectedComponents } from "@code-health/graph/scc";
import { findCycles } from "../cycles.ts";
import { rankDependencies } from "../unstable.ts";
import { edgeKey } from "../project.ts";
import { round3 } from "../stability.ts";
import { measureAbstractness, type Abstractness } from "./abstractness.ts";
import { percent, raise, type Finding, type FindingContext } from "./findings.ts";
import type { ReuseAnalysis } from "./reuse-profile.ts";

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
  return rankDependencies(model.model, model.settings).map((row) =>
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
      {
        changeCost: cost.pair(row.from, row.to),
        ...(row.aboveGuideline
          ? {}
          : {
              belowGuideline:
                row.basis === "change"
                  ? `volatility ratio ${row.volatilityRatio} against ${model.settings.minVolatilityRatio}`
                  : `instability gap ${Math.round(((row.stability.to.structural.instability ?? 0) - (row.stability.from.structural.instability ?? 0)) * 100)} points against ${model.settings.minInstabilityGap}`,
            }),
      },
    ),
  );
}

const medianRevisions = (context: FindingContext): number => {
  const revisions = context.model.packages.map((p) => context.model.activity.revisions(p.id)).sort((a, b) => a - b);
  return revisions[Math.floor((revisions.length - 1) / 2)] ?? 0;
};

/**
 * The zone of pain, concrete and stable and widely depended on, and the zone of uselessness, abstract and
 * unused. A stable concrete package that rarely changes is healthy, so the zone of pain also needs frequent
 * change. Where `A` is weak the finding says so and the change evidence carries it.
 */
export function zones(context: FindingContext, abstractness: ReadonlyMap<string, Abstractness>): Finding[] {
  const { model } = context;
  const { zoneDistance } = model.settings.packages;
  const median = medianRevisions(context);
  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    const measured = abstractness.get(pkg.id);
    const stability = model.model.structural.get(pkg.id);
    if (!measured || !stability || stability.instability === null) continue;
    const a = measured.value;
    const i = stability.instability;
    const revisions = model.activity.revisions(pkg.id);
    const evidence = {
      abstractness: a,
      instability: i,
      distance: round3(Math.abs(a + i - 1)),
      ca: stability.ca,
      ce: stability.ce,
      revisions,
      medianRevisions: median,
      exportedTypes: measured.exportedTypes,
      abstractnessWeak: measured.weak,
    };
    const distance = Math.abs(a + i - 1);
    const below = { belowGuideline: `distance ${round3(distance)} against ${zoneDistance}` };
    if (a + i < 1 && stability.ca >= 2 && revisions > median && revisions >= model.settings.minRevisions) {
      findings.push(
        raise(context, "zone-of-pain", "SAP", [pkg.id],
          `${pkg.id} is concrete (A ${a}) and stable (I ${i}), ${stability.ca} packages depend on it, and it changed in ${revisions} changes: every change ripples${measured.weak ? "; A is weak here, so the change evidence carries this" : ""}`,
          evidence,
          { changeCost: context.cost.package(pkg.id), ...(distance >= zoneDistance ? {} : below) }),
      );
    }
    if (a + i > 1 && measured.exportedTypes >= 1 && stability.ca <= 1) {
      findings.push(
        raise(context, "zone-of-uselessness", "SAP", [pkg.id],
          `${pkg.id} is abstract (A ${a}) and has ${stability.ca === 0 ? "no dependents" : "one dependent"} (I ${i}): abstractions written for consumers that never arrived`,
          evidence,
          { changeCost: 0, ...(distance >= zoneDistance ? {} : below) }),
      );
    }
  }
  return findings;
}

/**
 * The exported surface changes in a large share of a package's revisions. Surface changes are read as changes to
 * the files that define what the package exports, which counts a change inside an exported function too.
 */
export function volatileInterfaces(context: FindingContext, reuse: ReuseAnalysis): Finding[] {
  const { model } = context;
  const { volatileInterfaceShare } = model.settings.packages;
  const findings: Finding[] = [];
  for (const [id, profile] of reuse.profiles) {
    if (profile.consumers.length === 0 || profile.surface.length === 0) continue;
    const defining = new Set(profile.surface.map((e) => e.file));
    const touching = model.changes.filter((c) => c.touched.includes(id));
    if (touching.length < model.settings.minRevisions) continue;
    const onSurface = touching.filter((c) => c.files.some((f) => f.package === id && defining.has(f.path))).length;
    const share = onSurface / touching.length;
    findings.push(
      raise(context, "volatile-interface", "SDP", [id],
        `the files that define what ${id} exports changed in ${onSurface} of its ${touching.length} changes (${percent(share)}), with ${profile.consumers.length} consumer${profile.consumers.length === 1 ? "" : "s"} depending on them`,
        { surfaceChanges: onSurface, revisions: touching.length, share: round3(share), consumers: profile.consumers.length, surfaceFiles: [...defining].sort(compareIds).slice(0, 10) },
        { changeCost: context.cost.package(id), ...(share >= volatileInterfaceShare ? {} : { belowGuideline: `${percent(share)} of revisions against ${percent(volatileInterfaceShare)}` }) }),
    );
  }
  return findings;
}

/** The package cycles, stability against change, the zones, and the volatile interfaces. */
export function couplingFindings(context: FindingContext, reuse: ReuseAnalysis): Finding[] {
  return [
    ...packageCycles(context),
    ...hiddenCycles(context),
    ...againstStability(context),
    ...zones(context, measureAbstractness(reuse)),
    ...volatileInterfaces(context, reuse),
  ];
}

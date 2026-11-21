import { compareIds } from "@code-health/graph/graph";
import type { Census } from "./census/census.ts";
import { nearbyMechanisms, type NearbyMechanism } from "./census/nearby.ts";
import type { Unblock } from "./locality-report.ts";
import { findCycles, unblocksOf } from "./cycles.ts";
import { couplingId, judgePair, orientPair, type QuadrantJudgement } from "./coupling.ts";
import { findLayerViolations, layerViolationId, type LayerViolation } from "./layers.ts";
import type { StructureSettings } from "./config.ts";
import type { Model } from "./model.ts";
import { describeEdge, type SymbolUse } from "./modules.ts";
import { edgeKey, folderOf } from "./project.ts";
import { round3, type AgainstStability, type Stability } from "./stability.ts";
import { judgeEdge, stabilityOfModule, unstableId } from "./unstable.ts";
import type { Hub, HubFeature } from "./hubs.ts";

const round1 = (value: number): number => Math.round(value * 10) / 10;

export type ProblemKind = "cycle" | "layer-violation" | "unstable-dependency" | "incidental-coupling" | "hidden-coupling" | "registration-hub";

export interface CoChangeFigures {
  /** Eligible logical changes that touched both sides. */
  shared: number;
  fromChanges: number;
  toChanges: number;
  /** Percent of changes to `from` that also touched `to`. */
  confidenceFromTo: number;
  /** Percent of changes to `to` that also touched `from`. */
  confidenceToFrom: number;
  /** What independence would predict: `fromChanges * toChanges / eligibleChanges`. */
  expected: number;
  eligibleChanges: number;
}

export interface Misplacement {
  symbol: string;
  /** Distinct files other than the defining one that use it. */
  consumerFiles: number;
  onFromSide: number;
  onToSide: number;
  elsewhere: number;
  /** The side holding a strict majority of the consumer files, or "split". */
  mostlyOn: "from" | "to" | "split";
  /** Its consumers mostly sit on the depending side, so moving it there may remove the dependency. */
  moveMayRemoveDependency: boolean;
}

export interface EvidencePack {
  id: string;
  /** The first problem the edge is part of, or null when it is no problem at all. */
  kind: ProblemKind | null;
  /** Every problem the edge is part of. */
  kinds: ProblemKind[];
  /** Ids of the findings (`cycle:...`, `unstable:...`) the edge belongs to. */
  findings: string[];
  level: string;
  from: string;
  to: string;
  /** Where the pair sits in the coupling quadrants, with the static coupling, co-change and expected co-change behind it. */
  quadrant: QuadrantJudgement;
  /** The cycle's minimum breaking set contains this edge. Null when the edge is in no cycle. */
  inBreakingSet: boolean | null;
  /** The symbols used across the boundary, most used first. */
  breakingSet: SymbolUse[];
  imports: { fileEdges: number; importStatements: number; typeOnly: boolean; files: { from: string; to: string }[] };
  stability: { from: Stability; to: Stability };
  stabilityVerdict: AgainstStability;
  coChange: CoChangeFigures;
  misplacement: Misplacement[];
  unblocks: Unblock[];
  /** Census entries in or next to the two modules, nearest first. See `structure census` for the whole inventory. */
  nearbyMechanisms: NearbyMechanism[];
  /** The layer rules the edge's imports break, one entry per pair of layers, or null when it breaks none. */
  layerRule: LayerRuleBreach[] | null;
}

export interface LayerRuleBreach {
  fromLayer: string;
  toLayer: string;
  /** What the rule lets `fromLayer` depend on. */
  allowed: string[];
  /** The file imports of the edge that break it. */
  fileEdges: { from: string; to: string }[];
}

const violationsByProject = new WeakMap<object, LayerViolation[]>();

function layerRule(model: Model, from: string, to: string, settings: Pick<StructureSettings, "layers">): LayerRuleBreach[] | null {
  if (settings.layers.length === 0) return null;
  let violations = violationsByProject.get(model.project);
  if (violations === undefined) {
    violations = findLayerViolations(model.project, settings.layers);
    violationsByProject.set(model.project, violations);
  }
  const members = new Set((model.graph.members.get(edgeKey(from, to)) ?? []).map((e) => edgeKey(e.from, e.to)));
  const breaches = new Map<string, LayerRuleBreach>();
  for (const violation of violations) {
    if (!members.has(edgeKey(violation.from, violation.to))) continue;
    const key = `${violation.fromLayer}\u0000${violation.toLayer}`;
    const breach = breaches.get(key) ?? { fromLayer: violation.fromLayer, toLayer: violation.toLayer, allowed: violation.allowed, fileEdges: [] };
    breach.fileEdges.push({ from: violation.from, to: violation.to });
    breaches.set(key, breach);
  }
  return breaches.size === 0 ? null : [...breaches.values()];
}

function coChangeFigures(model: Model, from: string, to: string): CoChangeFigures {
  const { activity } = model;
  const fromChanges = activity.eligibleRevisions(from);
  const toChanges = activity.eligibleRevisions(to);
  const shared = activity.shared(from, to);
  const total = activity.eligibleChanges;
  return {
    shared,
    fromChanges,
    toChanges,
    confidenceFromTo: fromChanges === 0 ? 0 : round1((shared / fromChanges) * 100),
    confidenceToFrom: toChanges === 0 ? 0 : round1((shared / toChanges) * 100),
    expected: total === 0 ? 0 : round3((fromChanges * toChanges) / total),
    eligibleChanges: total,
  };
}

/** For each symbol crossing the boundary, which side its consumers sit on. */
function misplacement(model: Model, from: string, to: string, symbols: readonly SymbolUse[]): Misplacement[] {
  const wanted = new Set(symbols.map((s) => s.symbol));
  const consumers = new Map<string, Set<string>>();
  for (const use of model.project.analysis.consumers) {
    if (use.kind === "test") continue;
    const symbol = `${use.to}#${use.toSymbol ?? use.toExport}`;
    if (!wanted.has(symbol) || use.from === use.to) continue;
    if (!consumers.has(symbol)) consumers.set(symbol, new Set());
    consumers.get(symbol)!.add(use.from);
  }
  return symbols.map(({ symbol }): Misplacement => {
    const files = [...(consumers.get(symbol) ?? [])];
    let onFromSide = 0;
    let onToSide = 0;
    for (const file of files) {
      const side = model.graph.moduleByFile.get(file);
      if (side === from) onFromSide++;
      else if (side === to) onToSide++;
    }
    const total = files.length;
    const mostlyOn = onFromSide * 2 > total ? "from" : onToSide * 2 > total ? "to" : "split";
    return {
      symbol,
      consumerFiles: total,
      onFromSide,
      onToSide,
      elsewhere: total - onFromSide - onToSide,
      mostlyOn,
      moveMayRemoveDependency: mostlyOn === "from",
    };
  });
}

/** The full evidence pack for one dependency between two modules of the model. The pack recommends nothing. */
export function evidencePack(
  model: Model,
  from: string,
  to: string,
  settings: Pick<
    StructureSettings,
    "exactLimit" | "minVolatilityRatio" | "minInstabilityGap" | "layers" | "minStaticCoupling" | "minSupport" | "minRevisions" | "significanceLevel"
  >,
  census: Census,
): EvidencePack {
  const level = model.graph.level;
  const detail = describeEdge(model.project, model.graph, from, to);
  const judged = judgeEdge(model, from, to, settings);
  const { stability, id: _id, level: _l, from: _f, to: _t, fileEdges: _e, ...verdict } = judged;
  const row = findCycles(model, settings).find((c) => c.nodes.includes(from) && c.nodes.includes(to));
  const cycle = row && { id: row.id, inBreakingSet: row.breakingSet.some((e) => e.from === from && e.to === to) };

  const kinds: ProblemKind[] = [];
  const findings: string[] = [];
  if (cycle) {
    kinds.push("cycle");
    findings.push(cycle.id);
  }
  const rule = layerRule(model, from, to, settings);
  if (rule) {
    kinds.push("layer-violation");
    for (const breach of rule) for (const edge of breach.fileEdges) findings.push(layerViolationId(edge.from, edge.to));
  }
  if (verdict.violates) {
    kinds.push("unstable-dependency");
    findings.push(unstableId(level, from, to));
  }

  const quadrant = judgePair(model.project, model.graph, model.activity, from, to, settings);
  if (quadrant.name === "incidental" || quadrant.name === "hidden") {
    kinds.push(quadrant.name === "incidental" ? "incidental-coupling" : "hidden-coupling");
    const [a, b] = orientPair(model.project, model.graph, from, to);
    findings.push(couplingId(level, a, b));
  }

  return {
    id: `edge:${level}:${from}->${to}`,
    kind: kinds[0] ?? null,
    kinds,
    findings,
    level,
    from,
    to,
    quadrant,
    inBreakingSet: cycle ? cycle.inBreakingSet : null,
    breakingSet: detail.symbols,
    imports: {
      fileEdges: detail.fileEdges,
      importStatements: detail.importStatements,
      typeOnly: detail.typeOnly,
      files: [...(model.graph.members.get(edgeKey(from, to)) ?? [])],
    },
    stability,
    stabilityVerdict: verdict,
    coChange: coChangeFigures(model, from, to),
    misplacement: misplacement(model, from, to, detail.symbols),
    unblocks: unblocksOf(model, from, to).sort((a, b) => b.unblockedGain - a.unblockedGain || compareIds(a.unit, b.unit)),
    nearbyMechanisms: nearbyMechanisms(
      census,
      (model.graph.filesOf.get(from) ?? []).map(folderOf),
      (model.graph.filesOf.get(to) ?? []).map(folderOf),
    ),
    layerRule: rule,
  };
}

export interface HubFeaturePack extends HubFeature {
  /** The symbols the hub uses from the feature, most used first. Empty when the hub only names the feature in a path string. */
  breakingSet: SymbolUse[];
  misplacement: Misplacement[];
}

/** The evidence for a registration hub: the file every feature edits, with what it uses from each feature. It recommends nothing. */
export interface HubEvidencePack {
  id: string;
  kind: "registration-hub";
  kinds: ["registration-hub"];
  findings: string[];
  level: string;
  file: string;
  module: string;
  featureCount: number;
  revisions: number;
  features: HubFeaturePack[];
  signals: Hub["signals"];
  /** Structural and change stability of the module the hub sits in. */
  stability: Stability | null;
  /** Locality moves blocked by the hub's imports of its features, read from the locality report when present. */
  unblocks: Unblock[];
  /** Census entries in or next to the hub's folder and its features, nearest first. */
  nearbyMechanisms: NearbyMechanism[];
}

export function hubEvidencePack(model: Model, hub: Hub, census: Census): HubEvidencePack {
  const features = hub.features.map((feature): HubFeaturePack => {
    const imported = model.graph.graph.get(hub.module)?.includes(feature.module) === true;
    const detail = imported ? describeEdge(model.project, model.graph, hub.module, feature.module) : undefined;
    const symbols = detail?.symbols ?? [];
    return { ...feature, breakingSet: symbols, misplacement: misplacement(model, hub.module, feature.module, symbols) };
  });
  const unblocks = hub.features
    .flatMap((feature) => (model.graph.graph.get(hub.module)?.includes(feature.module) ? unblocksOf(model, hub.module, feature.module) : []))
    .sort((a, b) => b.unblockedGain - a.unblockedGain || compareIds(a.unit, b.unit));
  return {
    id: hub.id,
    kind: "registration-hub",
    kinds: ["registration-hub"],
    findings: [hub.id],
    level: hub.level,
    file: hub.file,
    module: hub.module,
    featureCount: hub.featureCount,
    revisions: hub.revisions,
    features,
    signals: hub.signals,
    stability: stabilityOfModule(model, hub.module) ?? null,
    unblocks,
    nearbyMechanisms: nearbyMechanisms(
      census,
      [folderOf(hub.file)],
      hub.features.flatMap((feature) => (model.graph.filesOf.get(feature.module) ?? []).map(folderOf)),
    ),
  };
}

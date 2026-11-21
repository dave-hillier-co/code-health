import { compareIds } from "@code-health/graph/graph";
import type { StructureSettings } from "./config.ts";
import type { Model } from "./model.ts";
import { judgeDependency, round3, stabilityOf, type AgainstStability, type Stability } from "./stability.ts";

export interface UnstableDependency extends AgainstStability {
  id: string;
  level: string;
  from: string;
  to: string;
  fileEdges: number;
  stability: { from: Stability; to: Stability };
}

export interface UnitStability extends Stability {
  id: string;
}

export const unstableId = (level: string, from: string, to: string): string => `unstable:${level}:${from}->${to}`;

/** The stability figures of one module, or undefined when it is not in the model. */
export function stabilityOfModule(model: Model, id: string): Stability | undefined {
  return model.structural.has(id) && model.change.has(id) ? stabilityOf(model.structural, model.change, id) : undefined;
}

/** Judges one dependency between two modules of the model. */
export function judgeEdge(model: Model, from: string, to: string, settings: Pick<StructureSettings, "minVolatilityRatio" | "minInstabilityGap">): UnstableDependency {
  const stability = { from: stabilityOf(model.structural, model.change, from), to: stabilityOf(model.structural, model.change, to) };
  return {
    id: unstableId(model.graph.level, from, to),
    level: model.graph.level,
    from,
    to,
    fileEdges: model.graph.members.get(`${from}\u0000${to}`)?.length ?? 0,
    stability,
    ...judgeDependency(stability.from, stability.to, settings),
  };
}

/**
 * Dependencies that point from more stable towards less stable code. Change evidence outranks
 * structure, so rows decided by change come first, then by how much more volatile the depended-on
 * side is (or, on structure, how much more unstable), then by the number of file imports behind
 * the edge, then by path.
 */
export function findUnstableDependencies(model: Model, settings: Pick<StructureSettings, "minVolatilityRatio" | "minInstabilityGap">): UnstableDependency[] {
  const rows: UnstableDependency[] = [];
  for (const [from, targets] of model.graph.graph) {
    for (const to of targets) {
      const row = judgeEdge(model, from, to, settings);
      if (row.violates) rows.push(row);
    }
  }
  const margin = (row: UnstableDependency) =>
    row.basis === "change"
      ? round3(row.stability.to.change.revisionsPerFile - row.stability.from.change.revisionsPerFile)
      : round3((row.stability.to.structural.instability ?? 0) - (row.stability.from.structural.instability ?? 0));
  return rows.sort(
    (a, b) =>
      Number(b.basis === "change") - Number(a.basis === "change") ||
      margin(b) - margin(a) ||
      b.fileEdges - a.fileEdges ||
      compareIds(a.from, b.from) ||
      compareIds(a.to, b.to),
  );
}

/** Every module's stability, the most volatile first. */
export function unitStabilities(model: Model): UnitStability[] {
  return [...model.graph.filesOf.keys()]
    .map((id): UnitStability => ({ id, ...stabilityOf(model.structural, model.change, id) }))
    .sort((a, b) => b.change.revisionsPerFile - a.change.revisionsPerFile || compareIds(a.id, b.id));
}

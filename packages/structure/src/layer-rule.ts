import type { StructureSettings } from "./config.ts";
import { findLayerViolations, type LayerViolation } from "./layers.ts";
import type { Model } from "./model.ts";
import { edgeKey } from "./project.ts";

export interface LayerRuleBreach {
  fromLayer: string;
  toLayer: string;
  /** What the rule lets `fromLayer` depend on. */
  allowed: string[];
  /** The file imports of the edge that break it. */
  fileEdges: { from: string; to: string }[];
}

const violationsByProject = new WeakMap<object, LayerViolation[]>();

/** The layer rules the imports between two modules break, or null when they break none. */
export function layerRuleOf(model: Model, from: string, to: string, settings: Pick<StructureSettings, "layers">): LayerRuleBreach[] | null {
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

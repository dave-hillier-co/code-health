import { compareIds } from "@code-health/graph/graph";
import type { Activity } from "./activity.ts";
import type { StructureSettings } from "./config.ts";
import type { Model } from "./model.ts";
import { describeEdge, type ModuleGraph } from "./modules.ts";
import type { Project } from "./project.ts";
import { coChangePValue } from "./significance.ts";
import { round3 } from "./stability.ts";

/**
 * What a dependency between two modules is costing, from static coupling and co-change together.
 * `insufficient-evidence` is placed in no quadrant: too little activity to tell.
 */
export type Quadrant = "real" | "incidental" | "stable" | "hidden" | "independent" | "insufficient-evidence";

export const QUADRANTS: readonly Quadrant[] = ["real", "incidental", "hidden", "stable", "independent", "insufficient-evidence"];

type CouplingSettings = Pick<StructureSettings, "minStaticCoupling" | "minSupport" | "minRevisions" | "significanceLevel">;

export interface StaticCoupling {
  /** Reference sites of the other side's symbols, both directions together. */
  sites: number;
  /** Distinct symbols used across the boundary, both directions together. */
  symbols: number;
  fromTo: number;
  toFrom: number;
  /** `sites` reaches the configured minimum. */
  high: boolean;
}

export interface CoChangeJudgement {
  /** Eligible logical changes that touched both sides. */
  shared: number;
  fromChanges: number;
  toChanges: number;
  /** What independence would predict: `fromChanges * toChanges / eligibleChanges`. */
  expected: number;
  /** Chance of at least `shared` shared changes if the sides changed independently (one-sided exact test). */
  pValue: number;
  /** Support clears the minimum and the count is significantly above what independence predicts. */
  high: boolean;
}

export interface QuadrantJudgement {
  name: Quadrant;
  staticCoupling: StaticCoupling;
  coChange: CoChangeJudgement;
  /** Each side has at least the minimum revisions in the window. */
  bothActive: boolean;
}

/** The sites and distinct symbols one module uses of another. */
function usage(project: Project, graph: ModuleGraph, from: string, to: string): { sites: number; symbols: number } {
  const detail = describeEdge(project, graph, from, to);
  return { sites: detail.symbols.reduce((sum, s) => sum + s.sites, 0), symbols: detail.symbols.length };
}

function staticCoupling(project: Project, graph: ModuleGraph, from: string, to: string, settings: CouplingSettings): StaticCoupling {
  const forward = usage(project, graph, from, to);
  const backward = usage(project, graph, to, from);
  const sites = forward.sites + backward.sites;
  return { sites, symbols: forward.symbols + backward.symbols, fromTo: forward.sites, toFrom: backward.sites, high: sites >= settings.minStaticCoupling };
}

/**
 * The quadrant of a pair, where `to` is the depended-on side. Co-change is judged against what
 * independence predicts, not against zero (see `coChangePValue`).
 *
 * - high static coupling, `to` rarely changes: stable (healthy); `from` rarely changes: insufficient evidence;
 *   both active: real when co-change is high, incidental when it is not.
 * - low static coupling: hidden when co-change is high; independent when both are active and it is not;
 *   insufficient evidence otherwise.
 */
export function judgePair(
  project: Project,
  graph: ModuleGraph,
  activity: Activity,
  from: string,
  to: string,
  settings: CouplingSettings,
): QuadrantJudgement {
  const coupling = staticCoupling(project, graph, from, to, settings);
  const shared = activity.shared(from, to);
  const fromChanges = activity.eligibleRevisions(from);
  const toChanges = activity.eligibleRevisions(to);
  const total = activity.eligibleChanges;
  const pValue = coChangePValue({ shared, a: fromChanges, b: toChanges, total });
  const high = shared >= settings.minSupport && pValue <= settings.significanceLevel;
  const fromActive = activity.revisions(from) >= settings.minRevisions;
  const toActive = activity.revisions(to) >= settings.minRevisions;
  const bothActive = fromActive && toActive;

  let name: Quadrant;
  if (coupling.high) {
    name = !toActive ? "stable" : !fromActive ? "insufficient-evidence" : high ? "real" : "incidental";
  } else {
    name = high ? "hidden" : bothActive ? "independent" : "insufficient-evidence";
  }
  return {
    name,
    staticCoupling: coupling,
    coChange: { shared, fromChanges, toChanges, expected: total === 0 ? 0 : round3((fromChanges * toChanges) / total), pValue, high },
    bothActive,
  };
}

export interface CouplingRow {
  id: string;
  level: string;
  from: string;
  to: string;
  quadrant: Quadrant;
  staticCoupling: StaticCoupling;
  coChange: CoChangeJudgement;
  bothActive: boolean;
}

export const couplingId = (level: string, from: string, to: string): string => `coupling:${level}:${from}->${to}`;

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** The pair as `findCoupling` reports it: `from` is the side that uses more of the other, or the earlier path when they use it equally or not at all. */
export function orientPair(project: Project, graph: ModuleGraph, x: string, y: string): [string, string] {
  const forward = usage(project, graph, x, y).sites;
  const backward = usage(project, graph, y, x).sites;
  return backward > forward || (backward === forward && compareIds(y, x) < 0) ? [y, x] : [x, y];
}

/**
 * Every pair of modules with a dependency between them, or with at least the minimum shared changes.
 * The model must count every pair (`everyPair`), or hidden pairs are missed. `from` is the side that
 * uses more of the other, or the earlier path when they use it equally or not at all. Rows are
 * ordered by quadrant, then by shared changes for real and hidden pairs, or static coupling for the
 * rest, then by path.
 */
export function findCoupling(model: Model, settings: CouplingSettings): CouplingRow[] {
  const pairs = new Map<string, [string, string]>();
  for (const [from, targets] of model.graph.graph) for (const to of targets) pairs.set(pairKey(from, to), [from, to]);
  for (const [a, b, shared] of model.activity.sharedPairs()) {
    if (shared >= settings.minSupport && model.graph.filesOf.has(a) && model.graph.filesOf.has(b)) pairs.set(pairKey(a, b), [a, b]);
  }

  const level = model.graph.level;
  const rows = [...pairs.values()].map(([x, y]): CouplingRow => {
    const [from, to] = orientPair(model.project, model.graph, x, y);
    const { name, staticCoupling, coChange, bothActive } = judgePair(model.project, model.graph, model.activity, from, to, settings);
    return { id: couplingId(level, from, to), level, from, to, quadrant: name, staticCoupling, coChange, bothActive };
  });
  const byShared = (row: CouplingRow) => row.quadrant === "real" || row.quadrant === "hidden";
  return rows.sort(
    (a, b) =>
      QUADRANTS.indexOf(a.quadrant) - QUADRANTS.indexOf(b.quadrant) ||
      (byShared(a) ? b.coChange.shared - a.coChange.shared || a.coChange.pValue - b.coChange.pValue : b.staticCoupling.sites - a.staticCoupling.sites) ||
      compareIds(a.id, b.id),
  );
}

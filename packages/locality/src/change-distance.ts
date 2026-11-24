import { compareIds } from "@code-health/graph/graph";
import { treeDistance } from "@code-health/graph/tree-distance";
import type { Model } from "./model.ts";

/** One import edge of a revision: its use count, and whether the importing file is reachable from an entry point. */
export interface RevisionEdge {
  from: string;
  to: string;
  weight: number;
  /** Only edges from reachable files count toward the total. */
  counted: boolean;
}

/** The figures of one revision. */
export interface RevisionDistance {
  /**
   * Sum over counted edges of use count times tree distance. It is `metrics.totalWeightedDistance` of `analyse`
   * without the co-change weighting, which depends on the history window and so is not a property of one revision.
   */
  totalUseDistance: number;
  /** Counted edges. */
  edges: number;
  /** Sum of their use counts. */
  uses: number;
  /** Total divided by uses, or null with no uses. */
  meanDistancePerUse: number | null;
}

export type EdgeChangeKind = "added" | "removed" | "moved" | "reweighted" | "reachability";

/** One edge whose contribution to the total differs between the two revisions. Paths are those of the later revision, except for a removed edge. */
export interface EdgeChange {
  from: string;
  to: string;
  kind: EdgeChangeKind;
  /** Use count and tree distance in each revision, or null where the edge is absent. */
  before: { weight: number; distance: number } | null;
  after: { weight: number; distance: number } | null;
  /** What the edge adds to the total: negative when it takes distance away. */
  change: number;
}

interface Part {
  edges: number;
  distance: number;
}

export interface ChangeDistance {
  before: RevisionDistance;
  after: RevisionDistance;
  /** After minus before. It equals added minus removed plus moved, reweighted and reachability. */
  delta: number;
  parts: {
    /** Edges the later revision has and the earlier lacks. */
    added: Part & { uses: number; meanDistancePerUse: number | null; ratioToCodebaseMean: number | null };
    /** Edges the earlier revision has and the later lacks. `distance` is what they took away, as a positive number. */
    removed: Part & { uses: number; meanDistancePerUse: number | null };
    /** Edges in both whose distance changed because a file at one end moved: earlier use count times the change in distance. */
    moved: Part;
    /** Edges in both whose use count changed: the change in use count times the later distance. */
    reweighted: Part & { uses: number };
    /** Edges in both whose importing file became reachable from an entry point, or stopped being reachable. */
    reachability: Part;
  };
  /** Every edge whose contribution or use count changed, largest absolute change first. */
  edges: EdgeChange[];
}

/** The edges of a model, with whether each counts toward the total. */
export function revisionEdges(model: Model): RevisionEdge[] {
  return model.edges.map((edge) => ({ from: edge.from, to: edge.to, weight: edge.weight, counted: model.reachable.has(edge.from) }));
}

const keyOf = (from: string, to: string): string => `${from}\0${to}`;
const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);

function summarise(edges: readonly RevisionEdge[]): RevisionDistance {
  const counted = edges.filter((edge) => edge.counted);
  const total = counted.reduce((sum, edge) => sum + edge.weight * treeDistance(edge.from, edge.to), 0);
  const uses = counted.reduce((sum, edge) => sum + edge.weight, 0);
  return { totalUseDistance: total, edges: counted.length, uses, meanDistancePerUse: ratio(total, uses) };
}

/**
 * How the total import distance (use count times tree distance) differs between two revisions, split by cause. `renames` maps each path of
 * the earlier revision that was renamed to its path in the later one, so a moved file keeps its edges and the
 * change in their distance is reported as `moved` and not as edges removed and added.
 */
export function changeDistance(before: readonly RevisionEdge[], after: readonly RevisionEdge[], renames: ReadonlyMap<string, string>): ChangeDistance {
  const later = (path: string): string => renames.get(path) ?? path;
  const earlier = new Map(before.map((edge) => [keyOf(later(edge.from), later(edge.to)), edge]));
  const seen = new Set<string>();
  const parts: ChangeDistance["parts"] = {
    added: { edges: 0, uses: 0, distance: 0, meanDistancePerUse: null, ratioToCodebaseMean: null },
    removed: { edges: 0, uses: 0, distance: 0, meanDistancePerUse: null },
    moved: { edges: 0, distance: 0 },
    reweighted: { edges: 0, uses: 0, distance: 0 },
    reachability: { edges: 0, distance: 0 },
  };
  const rows: EdgeChange[] = [];

  for (const edge of after) {
    const key = keyOf(edge.from, edge.to);
    const was = earlier.get(key);
    seen.add(key);
    const distance = treeDistance(edge.from, edge.to);
    if (was === undefined) {
      if (!edge.counted) continue;
      parts.added.edges++;
      parts.added.uses += edge.weight;
      parts.added.distance += edge.weight * distance;
      rows.push({ from: edge.from, to: edge.to, kind: "added", before: null, after: { weight: edge.weight, distance }, change: edge.weight * distance });
      continue;
    }
    const wasDistance = treeDistance(was.from, was.to);
    const sides = { before: { weight: was.weight, distance: wasDistance }, after: { weight: edge.weight, distance } };
    if (was.counted !== edge.counted) {
      const change = edge.counted ? edge.weight * distance : -was.weight * wasDistance;
      parts.reachability.edges++;
      parts.reachability.distance += change;
      rows.push({ from: edge.from, to: edge.to, kind: "reachability", ...sides, change });
      continue;
    }
    if (!edge.counted) continue;
    const byMove = was.weight * (distance - wasDistance);
    const byWeight = (edge.weight - was.weight) * distance;
    if (distance !== wasDistance) {
      parts.moved.edges++;
      parts.moved.distance += byMove;
    }
    if (edge.weight !== was.weight) {
      parts.reweighted.edges++;
      parts.reweighted.uses += edge.weight - was.weight;
      parts.reweighted.distance += byWeight;
    }
    if (distance !== wasDistance || edge.weight !== was.weight) {
      rows.push({ from: edge.from, to: edge.to, kind: distance !== wasDistance ? "moved" : "reweighted", ...sides, change: byMove + byWeight });
    }
  }
  for (const [key, edge] of earlier) {
    if (seen.has(key) || !edge.counted) continue;
    const distance = treeDistance(edge.from, edge.to);
    parts.removed.edges++;
    parts.removed.uses += edge.weight;
    parts.removed.distance += edge.weight * distance;
    rows.push({ from: edge.from, to: edge.to, kind: "removed", before: { weight: edge.weight, distance }, after: null, change: -edge.weight * distance });
  }

  const start = summarise(before);
  const end = summarise(after);
  parts.added.meanDistancePerUse = ratio(parts.added.distance, parts.added.uses);
  parts.removed.meanDistancePerUse = ratio(parts.removed.distance, parts.removed.uses);
  parts.added.ratioToCodebaseMean =
    parts.added.meanDistancePerUse === null || start.meanDistancePerUse === null ? null : ratio(parts.added.meanDistancePerUse, start.meanDistancePerUse);
  rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || compareIds(a.from, b.from) || compareIds(a.to, b.to));
  return { before: start, after: end, delta: end.totalUseDistance - start.totalUseDistance, parts, edges: rows };
}

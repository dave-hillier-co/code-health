import { compareIds } from "@code-health/graph/graph";
import { depthOf, folderDistance } from "@code-health/graph/tree-distance";

/**
 * One edge across a unit's boundary: an incoming consumer or an outgoing dependency.
 * `inner` is the folder of the unit's own endpoint relative to the unit's base folder
 * (`""` when it sits at the base), because a move keeps the unit's internal layout.
 * `outer` is the folder of the endpoint that stays behind.
 */
export interface BoundaryEdge {
  inner: string;
  outer: string;
  weight: number;
}

export interface TargetChoice {
  /** The folder the unit's base should move to. */
  target: string;
  /** Net distance at the current base folder. */
  current: number;
  /** Net distance at the target. */
  distance: number;
  /** `current - distance`, never negative. */
  gain: number;
  /**
   * The folders that tie for best when two or more allowed folders at the same depth, neither containing the other, have the
   * same lowest distance. Then no single target is proposed: `target` is the base, `gain` is 0, and `tiedGain` is the gain each
   * tied folder would have. Empty when there is no such tie.
   */
  ties: string[];
  /** The gain at each tied folder, 0 when there is no tie. */
  tiedGain: number;
}

export interface TargetOptions {
  /** Targets deeper than this are not considered, so burying code cannot lower the score. */
  maxDepth: number;
  /** Folders code may not move into (framework conventions). The current base is always allowed. */
  forbidden?: (folder: string) => boolean;
}

function place(base: string, offset: string): string {
  if (offset === "") return base;
  return base === "" ? offset : `${base}/${offset}`;
}

/** The weighted sum of tree distances over the boundary edges, with the unit's base placed at `base`. */
export function netDistance(edges: readonly BoundaryEdge[], base: string): number {
  let sum = 0;
  for (const edge of edges) sum += edge.weight * folderDistance(place(base, edge.inner), edge.outer);
  return sum;
}

/**
 * The edges with the same two folders as one edge of their summed weight, in the order each pair is first seen. Every
 * candidate folder is measured against every edge, and a unit's many consumers in one folder are one term of the sum.
 * Whole weights are summed exactly in any order; edges with a fractional weight are kept as they are.
 */
function merged(edges: readonly BoundaryEdge[]): readonly BoundaryEdge[] {
  if (!edges.every((edge) => Number.isInteger(edge.weight))) return edges;
  const byPair = new Map<string, BoundaryEdge>();
  for (const edge of edges) {
    const key = `${edge.inner}\0${edge.outer}`;
    const found = byPair.get(key);
    if (found === undefined) byPair.set(key, { ...edge });
    else found.weight += edge.weight;
  }
  return [...byPair.values()];
}

/** The folder and every ancestor of it, root included. */
function chain(folder: string): string[] {
  if (folder === "") return [""];
  const parts = folder.split("/");
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/** Shallower first, then path order. */
function prefers(a: string, b: string): boolean {
  return depthOf(a) !== depthOf(b) ? depthOf(a) < depthOf(b) : compareIds(a, b) < 0;
}

/**
 * The folder that minimises net distance, found by evaluating the folders on the paths between the
 * edge endpoints (every ancestor of every endpoint). Ties go to the shallower folder. Folders at the same depth
 * with the same distance do not contain each other, so choosing one would be arbitrary: no target is proposed
 * and the tied folders are reported in `ties`.
 */
export function bestTarget(boundary: readonly BoundaryEdge[], base: string, options: TargetOptions): TargetChoice {
  const edges = merged(boundary);
  const current = netDistance(edges, base);
  const candidates = new Set<string>();
  for (const edge of edges) for (const folder of chain(edge.outer)) candidates.add(folder);

  let best = { target: base, distance: current };
  const allowed: { folder: string; distance: number }[] = [];
  for (const folder of [...candidates].sort(compareIds)) {
    if (folder === base) continue;
    if (depthOf(folder) > options.maxDepth) continue;
    if (options.forbidden?.(folder)) continue;
    const distance = netDistance(edges, folder);
    allowed.push({ folder, distance });
    if (distance < best.distance || (distance === best.distance && best.target !== base && prefers(folder, best.target))) {
      best = { target: folder, distance };
    }
  }
  if (best.target !== base) {
    const tied = allowed.filter((entry) => entry.distance === best.distance && depthOf(entry.folder) === depthOf(best.target)).map((entry) => entry.folder);
    if (tied.length > 1) {
      return { target: base, current, distance: current, gain: 0, ties: tied, tiedGain: current - best.distance };
    }
  }
  return { target: best.target, current, distance: best.distance, gain: current - best.distance, ties: [], tiedGain: 0 };
}

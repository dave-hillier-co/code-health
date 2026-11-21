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
 * edge endpoints (every ancestor of every endpoint). Ties go to the shallower folder, then to path order.
 */
export function bestTarget(edges: readonly BoundaryEdge[], base: string, options: TargetOptions): TargetChoice {
  const current = netDistance(edges, base);
  const candidates = new Set<string>();
  for (const edge of edges) for (const folder of chain(edge.outer)) candidates.add(folder);

  let best = { target: base, distance: current };
  for (const folder of [...candidates].sort(compareIds)) {
    if (folder === base) continue;
    if (depthOf(folder) > options.maxDepth) continue;
    if (options.forbidden?.(folder)) continue;
    const distance = netDistance(edges, folder);
    if (distance < best.distance || (distance === best.distance && best.target !== base && prefers(folder, best.target))) {
      best = { target: folder, distance };
    }
  }
  return { target: best.target, current, distance: best.distance, gain: current - best.distance };
}

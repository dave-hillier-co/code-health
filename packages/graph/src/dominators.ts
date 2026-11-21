import { compareIds, reachableFrom, type Graph } from "./graph.ts";

export interface DominatorTree {
  root: string;
  /** Immediate dominator of every node reachable from the root, except the root itself. */
  idom: ReadonlyMap<string, string>;
}

/**
 * Dominator tree by Cooper, Harvey and Kennedy, "A Simple, Fast Dominance Algorithm".
 * The tree is unique, so the result does not depend on the order nodes or edges are listed in.
 * Nodes the root cannot reach have no dominator and are absent from the tree.
 */
export function dominatorTree(graph: Graph, root: string): DominatorTree {
  if (!graph.has(root)) return { root, idom: new Map() };

  // Iterative depth-first search giving postorder numbers.
  const postorder: string[] = [];
  const number = new Map<string, number>();
  const visited = new Set<string>([root]);
  const frames: { id: string; next: number }[] = [{ id: root, next: 0 }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const targets = graph.get(frame.id) ?? [];
    if (frame.next < targets.length) {
      const to = targets[frame.next++]!;
      if (graph.has(to) && !visited.has(to)) {
        visited.add(to);
        frames.push({ id: to, next: 0 });
      }
    } else {
      frames.pop();
      number.set(frame.id, postorder.length);
      postorder.push(frame.id);
    }
  }

  const predecessors = new Map<string, string[]>();
  for (const id of postorder) predecessors.set(id, []);
  for (const id of postorder) {
    for (const to of graph.get(id) ?? []) predecessors.get(to)?.push(id);
  }

  const idom = new Map<string, string>([[root, root]]);
  const intersect = (a: string, b: string): string => {
    while (a !== b) {
      while (number.get(a)! < number.get(b)!) a = idom.get(a)!;
      while (number.get(b)! < number.get(a)!) b = idom.get(b)!;
    }
    return a;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = postorder.length - 2; i >= 0; i--) {
      const id = postorder[i]!;
      let candidate: string | undefined;
      for (const pred of predecessors.get(id)!) {
        if (!idom.has(pred)) continue;
        candidate = candidate === undefined ? pred : intersect(pred, candidate);
      }
      if (candidate !== undefined && idom.get(id) !== candidate) {
        idom.set(id, candidate);
        changed = true;
      }
    }
  }

  idom.delete(root);
  const sorted = new Map<string, string>();
  for (const id of [...idom.keys()].sort(compareIds)) sorted.set(id, idom.get(id)!);
  return { root, idom: sorted };
}

/** Nodes in the graph the root cannot reach (dead code, or an entry point missing from config), sorted. */
export function unreachableFrom(graph: Graph, root: string): string[] {
  const reachable = reachableFrom(graph, [root]);
  return [...graph.keys()].filter((id) => !reachable.has(id)).sort(compareIds);
}

function inTree(tree: DominatorTree, id: string): boolean {
  return id === tree.root || tree.idom.has(id);
}

/** True when `d` dominates `n`: every path from the root to `n` passes through `d`. A node dominates itself. */
export function dominates(tree: DominatorTree, d: string, n: string): boolean {
  if (!inTree(tree, n) || !inTree(tree, d)) return false;
  for (let current: string | undefined = n; current !== undefined; current = tree.idom.get(current)) {
    if (current === d) return true;
  }
  return false;
}

/** `d` and everything it dominates, sorted. This is a movable unit for locality. */
export function dominatedSubtree(tree: DominatorTree, d: string): string[] {
  if (!inTree(tree, d)) return [];
  const children = new Map<string, string[]>();
  for (const [id, parent] of tree.idom) {
    let list = children.get(parent);
    if (!list) children.set(parent, (list = []));
    list.push(id);
  }
  const result: string[] = [];
  const stack = [d];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return result.sort(compareIds);
}

/** The deepest node that dominates both `a` and `b`, or undefined when either is outside the tree. */
export function lowestCommonDominator(tree: DominatorTree, a: string, b: string): string | undefined {
  if (!inTree(tree, a) || !inTree(tree, b)) return undefined;
  const ancestors = new Set<string>();
  for (let current: string | undefined = a; current !== undefined; current = tree.idom.get(current)) {
    ancestors.add(current);
  }
  for (let current: string | undefined = b; current !== undefined; current = tree.idom.get(current)) {
    if (ancestors.has(current)) return current;
  }
  return undefined;
}

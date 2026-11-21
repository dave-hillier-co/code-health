import { compareIds, normalise, type Graph } from "./graph.ts";

/**
 * Strongly connected components by Tarjan's algorithm, run iteratively so deep import chains
 * cannot overflow the call stack. Members of each component are sorted, and components are
 * ordered by their lowest member, so the result does not depend on traversal order.
 * A node with no cycle is a singleton component.
 */
export function stronglyConnectedComponents(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const frames: { id: string; next: number }[] = [{ id: start, next: 0 }];
    index.set(start, counter);
    lowlink.set(start, counter++);
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = graph.get(frame.id) ?? [];
      if (frame.next < targets.length) {
        const to = targets[frame.next++]!;
        if (!graph.has(to)) continue;
        if (!index.has(to)) {
          index.set(to, counter);
          lowlink.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          frames.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        lowlink.set(parent.id, Math.min(lowlink.get(parent.id)!, lowlink.get(frame.id)!));
      }
      if (lowlink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        components.push(component.sort(compareIds));
      }
    }
  }
  return components.sort((a, b) => compareIds(a[0]!, b[0]!));
}

export interface Condensation {
  /** The acyclic graph over component ids. A component is named by its lowest member. */
  graph: Graph;
  /** Component id for every original node. */
  componentOf: ReadonlyMap<string, string>;
  /** Members of every component, sorted, keyed by component id. */
  members: ReadonlyMap<string, readonly string[]>;
}

/** Collapse each strongly connected component into one node, so a cycle can only move whole. */
export function condense(graph: Graph): Condensation {
  const components = stronglyConnectedComponents(graph);
  const componentOf = new Map<string, string>();
  const members = new Map<string, readonly string[]>();
  for (const component of components) {
    members.set(component[0]!, component);
    for (const id of component) componentOf.set(id, component[0]!);
  }
  const edges = new Map<string, string[]>();
  for (const id of members.keys()) edges.set(id, []);
  for (const [from, targets] of graph) {
    const source = componentOf.get(from)!;
    for (const to of targets) {
      const target = componentOf.get(to);
      if (target !== undefined && target !== source) edges.get(source)!.push(target);
    }
  }
  return { graph: normalise(edges), componentOf, members };
}

/** The original nodes inside a condensed node. */
export function expandComponent(condensation: Condensation, componentId: string): readonly string[] {
  return condensation.members.get(componentId) ?? [];
}

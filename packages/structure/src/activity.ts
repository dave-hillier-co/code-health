import type { LogicalChange } from "@code-health/history/noise";
import type { ModuleGraph } from "./modules.ts";

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** What the history says about the modules of one level, over one window. */
export interface Activity {
  /** Logical changes at or below the maximum changeset size: the population every co-change figure is counted over. */
  eligibleChanges: number;
  /** Logical changes that touched the module. Oversized ones count, since frequency includes them. */
  revisions(module: string): number;
  /** Eligible logical changes that touched the module. */
  eligibleRevisions(module: string): number;
  /** Eligible logical changes that touched both modules. Only pairs asked for up front are counted. */
  shared(a: string, b: string): number;
  /** Lines added plus deleted in the module. */
  churn(module: string): number;
}

/**
 * Counts changes per module and shared changes per wanted pair. Files are identified by their
 * stable identity, so a moved file keeps its history, and only files still in the module graph count.
 * `wanted` lists the module pairs whose co-change will be asked for (the graph's edges), which
 * keeps the counting proportional to the graph and not to every pair a large change touches.
 */
export function measureActivity(changes: readonly LogicalChange[], graph: ModuleGraph, wanted: Iterable<[string, string]>): Activity {
  const wantedPairs = new Set<string>();
  for (const [a, b] of wanted) wantedPairs.add(pairKey(a, b));

  const revisions = new Map<string, number>();
  const eligibleRevisions = new Map<string, number>();
  const churn = new Map<string, number>();
  const shared = new Map<string, number>();
  let eligibleChanges = 0;

  for (const change of changes) {
    if (!change.oversized) eligibleChanges++;
    const touched = new Set<string>();
    for (const file of change.files) {
      const module = graph.moduleByFile.get(file.fileId);
      if (module === undefined) continue;
      touched.add(module);
      churn.set(module, (churn.get(module) ?? 0) + (file.added ?? 0) + (file.deleted ?? 0));
    }
    const modules = [...touched].sort();
    for (const module of modules) {
      revisions.set(module, (revisions.get(module) ?? 0) + 1);
      if (!change.oversized) eligibleRevisions.set(module, (eligibleRevisions.get(module) ?? 0) + 1);
    }
    if (change.oversized) continue;
    for (let i = 0; i < modules.length; i++) {
      for (let j = i + 1; j < modules.length; j++) {
        const key = pairKey(modules[i]!, modules[j]!);
        if (wantedPairs.has(key)) shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    eligibleChanges,
    revisions: (module) => revisions.get(module) ?? 0,
    eligibleRevisions: (module) => eligibleRevisions.get(module) ?? 0,
    shared: (a, b) => shared.get(pairKey(a, b)) ?? 0,
    churn: (module) => churn.get(module) ?? 0,
  };
}

/** Every unordered pair of connected modules in the graph, for `measureActivity`. */
export function connectedPairs(graph: ModuleGraph): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [from, targets] of graph.graph) for (const to of targets) pairs.push([from, to]);
  return pairs;
}

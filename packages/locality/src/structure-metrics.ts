import { depthOf, folderOf, treeDistance } from "@code-health/graph/tree-distance";
import type { Model } from "./model.ts";
import type { Project } from "./project.ts";

/** The leading indicator (total weighted import distance) and the gaming check's figures (single-file folders, depth). */
export interface StructureMetrics {
  totalWeightedDistance: number;
  singleFileFolders: number;
  maxDepth: number;
}

/** The structure figures of one revision: use count times tree distance over the edges from reachable files, and the folders the production files sit in. */
export function structureMetricsOf(project: Project, model: Model): StructureMetrics {
  const folders = new Map<string, number>();
  for (const file of project.production) folders.set(folderOf(file), (folders.get(folderOf(file)) ?? 0) + 1);
  return {
    totalWeightedDistance: model.edges.filter((edge) => model.reachable.has(edge.from)).reduce((sum, edge) => sum + edge.weight * treeDistance(edge.from, edge.to), 0),
    singleFileFolders: [...folders.values()].filter((count) => count === 1).length,
    maxDepth: Math.max(0, ...[...folders.keys()].map(depthOf)),
  };
}

export interface GamingCheck {
  flagged: boolean;
  reasons: string[];
}

/**
 * Whether a drop in import distance was bought by burying code. Distance that fell while more folders hold a
 * single file, or the tree got deeper, is distance hidden in nesting and not removed.
 */
export function gamingCheck(before: StructureMetrics | null, after: StructureMetrics): GamingCheck {
  if (before === null || after.totalWeightedDistance >= before.totalWeightedDistance) return { flagged: false, reasons: [] };
  const reasons: string[] = [];
  if (after.singleFileFolders > before.singleFileFolders) {
    reasons.push(`single-file folders rose from ${before.singleFileFolders} to ${after.singleFileFolders} while weighted import distance fell`);
  }
  if (after.maxDepth > before.maxDepth) {
    reasons.push(`maximum folder depth rose from ${before.maxDepth} to ${after.maxDepth} while weighted import distance fell`);
  }
  return { flagged: reasons.length > 0, reasons };
}

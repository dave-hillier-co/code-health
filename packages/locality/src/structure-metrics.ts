import type { AnalysisResult } from "./candidates.ts";

/** The leading indicator (total weighted import distance) and the gaming check's figures (single-file folders, depth). */
export type StructureMetrics = AnalysisResult["metrics"];

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

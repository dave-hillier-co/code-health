import { withAncestors } from "@code-health/graph/folders";
import { folderOf, treeDistance } from "@code-health/graph/tree-distance";
import type { RevisionEdge } from "./change-distance.ts";

/** The import distance of the files under one folder, the folder's subfolders included. The repository is the folder `""`. */
export interface FolderFigures {
  /** Production files under the folder. */
  files: number;
  /** Counted import edges whose importing file is under the folder. */
  edges: number;
  /** Sum of their use counts. */
  uses: number;
  /** Sum of use count times tree distance over those edges. */
  totalUseDistance: number;
  /** Total divided by uses, or null with no uses. */
  meanDistancePerUse: number | null;
}

/**
 * The figures of every folder of one revision. An edge belongs to the folder of its importing file and to every
 * folder above it, so each folder's figures are the sum of its subfolders' and its own files', up to the
 * repository. Only edges that count toward the total (those from files reachable from an entry point) are summed.
 */
export function folderFigures(production: readonly string[], edges: readonly RevisionEdge[]): Map<string, FolderFigures> {
  const figures = new Map<string, FolderFigures>();
  const at = (folder: string): FolderFigures => {
    let found = figures.get(folder);
    if (found === undefined) {
      found = { files: 0, edges: 0, uses: 0, totalUseDistance: 0, meanDistancePerUse: null };
      figures.set(folder, found);
    }
    return found;
  };
  at("");
  for (const file of production) for (const folder of withAncestors(folderOf(file))) at(folder).files++;
  for (const edge of edges) {
    if (!edge.counted) continue;
    const distance = edge.weight * treeDistance(edge.from, edge.to);
    for (const folder of withAncestors(folderOf(edge.from))) {
      const figure = at(folder);
      figure.edges++;
      figure.uses += edge.weight;
      figure.totalUseDistance += distance;
    }
  }
  for (const figure of figures.values()) figure.meanDistancePerUse = figure.uses === 0 ? null : figure.totalUseDistance / figure.uses;
  return figures;
}

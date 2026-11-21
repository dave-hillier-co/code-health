import { compareUtf8 } from "@code-health/parse/analyse-tree";
import { MECHANISMS, type Census, type Occurrence } from "./census.ts";

/** How many census entries an evidence pack lists. */
export const NEARBY_LIMIT = 10;

export interface NearbyMechanism {
  mechanism: Occurrence["mechanism"];
  variant: string;
  path: string;
  line: number | null;
  detail: string;
  /** Steps through the folder tree from the nearest of the occurrence's folders to the nearest folder of the nearest module. */
  distance: number;
  /** The side the entry is nearer to, or `both` when the two are equally near. */
  near: "from" | "to" | "both";
}

const segments = (folder: string): string[] => (folder === "." ? [] : folder.split("/"));

/** Steps between two folders: up to their common ancestor, then down. */
export function folderDistance(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return left.length + right.length - 2 * shared;
}

function distanceTo(folders: readonly string[], sideFolders: readonly string[]): number {
  let least = Infinity;
  for (const a of folders) for (const b of sideFolders) least = Math.min(least, folderDistance(a, b));
  return least;
}

/**
 * The census entries in or next to the two sides of a dependency, nearest first. A side is the folders of
 * its files, so a file module and a folder module are judged the same way. The list says what is near,
 * and nothing about whether it fits: absence from it, with the whole census at zero, is what says a
 * mechanism would be new.
 */
export function nearbyMechanisms(census: Census, from: readonly string[], to: readonly string[], limit: number = NEARBY_LIMIT): NearbyMechanism[] {
  return census.occurrences
    .map((o): NearbyMechanism => {
      const toFrom = distanceTo(o.folders, from);
      const toTo = distanceTo(o.folders, to);
      return {
        mechanism: o.mechanism,
        variant: o.variant,
        path: o.path,
        line: o.line,
        detail: o.detail,
        distance: Math.min(toFrom, toTo),
        near: toFrom === toTo ? "both" : toFrom < toTo ? "from" : "to",
      };
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        MECHANISMS.indexOf(a.mechanism) - MECHANISMS.indexOf(b.mechanism) ||
        compareUtf8(a.path, b.path) ||
        (a.line ?? 0) - (b.line ?? 0),
    )
    .slice(0, limit);
}

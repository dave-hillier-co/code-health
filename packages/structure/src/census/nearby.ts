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
  /**
   * Census occurrences this entry stands for: the same mechanism, variant and detail in the same folders.
   * `path` and `line` are the first of them.
   */
  count: number;
  /** The entry is in the package (crate, workspace member, project) of one of the two modules. */
  samePackage: boolean;
  /** Steps through the folder tree from the nearest of the occurrence's folders to the nearest folder of the nearest module. */
  distance: number;
  /** The side the entry is nearer to, or `both` when the two are equally near. */
  near: "from" | "to" | "both";
}

/** The files of each side of a dependency, and which package owns a path. */
export interface NearbySides {
  from: readonly string[];
  to: readonly string[];
  /** The id of the package that owns a file, as `structure packages` reports it. */
  packageOf(path: string): string;
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

const folderOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
};

/**
 * The census entries in or next to the two sides of a dependency: those in the package of either side first,
 * then nearest first. A side is the folders of its files, so a file module and a folder module are judged the
 * same way. Repeats of one entry in the same folders are listed once, with a count. The list says what is
 * near, and nothing about whether it fits: absence from it, with the whole census at zero, is what says a
 * mechanism would be new.
 */
export function nearbyMechanisms(census: Census, sides: NearbySides, limit: number = NEARBY_LIMIT): { listed: NearbyMechanism[]; omitted: number } {
  const listed = rankNearby(census, sides).slice(0, limit);
  return { listed, omitted: census.occurrences.length - listed.reduce((sum, entry) => sum + entry.count, 0) };
}

/** Every census entry ordered as `nearbyMechanisms` lists them, repeats collapsed. */
export function rankNearby(census: Census, sides: NearbySides): NearbyMechanism[] {
  const from = sides.from.map(folderOf);
  const to = sides.to.map(folderOf);
  const sidePackages = new Set([...sides.from, ...sides.to].map((path) => sides.packageOf(path)));
  const byKey = new Map<string, NearbyMechanism>();
  for (const o of census.occurrences) {
    const key = [o.mechanism, o.variant, o.detail, ...o.folders].join("\0");
    const seen = byKey.get(key);
    if (seen !== undefined) {
      seen.count++;
      continue;
    }
    const toFrom = distanceTo(o.folders, from);
    const toTo = distanceTo(o.folders, to);
    // A folder occurrence is the folder itself, so its package is the one that owns a file inside it.
    const owner = sides.packageOf(o.line === null ? `${o.path}/-` : o.path);
    byKey.set(key, {
      mechanism: o.mechanism,
      variant: o.variant,
      path: o.path,
      line: o.line,
      detail: o.detail,
      count: 1,
      samePackage: sidePackages.has(owner),
      distance: Math.min(toFrom, toTo),
      near: toFrom === toTo ? "both" : toFrom < toTo ? "from" : "to",
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      Number(b.samePackage) - Number(a.samePackage) ||
      a.distance - b.distance ||
      MECHANISMS.indexOf(a.mechanism) - MECHANISMS.indexOf(b.mechanism) ||
      compareUtf8(a.path, b.path) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

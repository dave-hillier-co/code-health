import { compareUtf8 } from "@code-health/parse/analyse-tree";
import { MECHANISMS, type Census, type Mechanism, type Occurrence } from "./census.ts";

/** How many example locations a row carries. */
export const EXAMPLES_PER_MECHANISM = 3;

export interface CensusRow {
  id: string;
  mechanism: Mechanism;
  /** Occurrences found. */
  count: number;
  /** Files holding an occurrence. Folder occurrences have no file. */
  files: number;
  variants: { variant: string; count: number }[];
  /** The folders each occurrence involves, most occurrences first. */
  folders: { folder: string; count: number }[];
  examples: { variant: string; path: string; line: number | null; detail: string }[];
  /** Calls that match the mechanism's names and were left out of `count`, one entry per name, most calls first. */
  lookAlikes: { name: string; count: number; definitions: number; detail: string }[];
}

function tally(keys: Iterable<string>): [string, number][] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || compareUtf8(a[0], b[0]));
}

/**
 * Examples spread over the folders: the first occurrence in each folder, busiest folder first,
 * then the rest in path order, until there are enough.
 */
function examplesOf(occurrences: readonly Occurrence[], folders: readonly { folder: string }[]): Occurrence[] {
  const chosen: Occurrence[] = [];
  for (const { folder } of folders) {
    const first = occurrences.find((o) => !chosen.includes(o) && o.folders.includes(folder));
    if (first) chosen.push(first);
    if (chosen.length === EXAMPLES_PER_MECHANISM) return chosen;
  }
  for (const o of occurrences) {
    if (chosen.length === EXAMPLES_PER_MECHANISM) break;
    if (!chosen.includes(o)) chosen.push(o);
  }
  return chosen;
}

/** One row per mechanism, in a fixed order, so the absence of a mechanism is as visible as its use. */
export function censusRows(census: Census): CensusRow[] {
  return MECHANISMS.map((mechanism): CensusRow => {
    const found = census.occurrences.filter((o) => o.mechanism === mechanism);
    const folders = tally(found.flatMap((o) => o.folders)).map(([folder, count]) => ({ folder, count }));
    return {
      id: `census:${mechanism}`,
      mechanism,
      count: found.length,
      files: new Set(found.filter((o) => o.line !== null).map((o) => o.path)).size,
      variants: tally(found.map((o) => o.variant)).map(([variant, count]) => ({ variant, count })),
      folders,
      examples: examplesOf(found, folders).map(({ variant, path, line, detail }) => ({ variant, path, line, detail })),
      lookAlikes: census.lookAlikes.filter((l) => l.mechanism === mechanism).map(({ name, count, definitions, detail }) => ({ name, count, definitions, detail })),
    };
  });
}

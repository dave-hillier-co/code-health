import { compareIds } from "@code-health/graph/graph";
import type { Unresolved, UnresolvedReason } from "@code-health/parse/resolved-dependencies";

/** How many distinct unresolved imports are listed for each reason. */
export const UNRESOLVED_SAMPLE_SIZE = 10;

/** One import the resolver could not follow, with how many statements are like it. */
export interface UnresolvedSample {
  /** The module the statement names, as written, or null for an expression. */
  specifier: string | null;
  /** The name that was not found in the module, for `export-not-found`. */
  name?: string;
  /** The file the specifier names, for `export-not-found`. */
  to?: string;
  /** Statements with this specifier and name. */
  imports: number;
  /** The first of them, by path then line. */
  from: string;
  line: number;
}

/**
 * The unresolved imports that recur most, for each reason: the distinct specifier and name pairs, most statements
 * first, then by specifier and name, at most `UNRESOLVED_SAMPLE_SIZE` of them. `unresolved` is in path and line order.
 */
export function sampleUnresolved(unresolved: readonly Unresolved[]): Partial<Record<UnresolvedReason, UnresolvedSample[]>> {
  const byReason = new Map<UnresolvedReason, Map<string, UnresolvedSample>>();
  for (const entry of unresolved) {
    let distinct = byReason.get(entry.reason);
    if (distinct === undefined) byReason.set(entry.reason, (distinct = new Map()));
    const key = `${entry.specifier ?? ""}\0${entry.name ?? ""}\0${entry.to ?? ""}`;
    const known = distinct.get(key);
    if (known !== undefined) known.imports++;
    else distinct.set(key, { specifier: entry.specifier, ...(entry.name === undefined ? {} : { name: entry.name }), ...(entry.to === undefined ? {} : { to: entry.to }), imports: 1, from: entry.from, line: entry.line });
  }
  const sample: Partial<Record<UnresolvedReason, UnresolvedSample[]>> = {};
  for (const reason of [...byReason.keys()].sort(compareIds)) {
    sample[reason] = [...byReason.get(reason)!.values()]
      .sort((a, b) => b.imports - a.imports || compareIds(a.specifier ?? "", b.specifier ?? "") || compareIds(a.name ?? "", b.name ?? "") || compareIds(a.from, b.from) || a.line - b.line)
      .slice(0, UNRESOLVED_SAMPLE_SIZE);
  }
  return sample;
}

/**
 * For a set of files, how many other production files have an import that names one of them and a name its exports
 * do not have. Each is a consumer the fan-in does not count: the name is defined by the file in a way the parser
 * does not read (a derive, a macro), or by a file it re-exports from.
 */
export function unresolvedFanInReader(unresolved: readonly Unresolved[], isProduction: (path: string) => boolean): (files: readonly string[]) => number {
  const aimedAt = new Map<string, Set<string>>();
  for (const entry of unresolved) {
    if (entry.to === undefined || !isProduction(entry.from)) continue;
    let from = aimedAt.get(entry.to);
    if (from === undefined) aimedAt.set(entry.to, (from = new Set()));
    from.add(entry.from);
  }
  return (files) => {
    const own = new Set(files);
    const consumers = new Set<string>();
    for (const file of files) for (const from of aimedAt.get(file) ?? []) if (!own.has(from)) consumers.add(from);
    return consumers.size;
  };
}

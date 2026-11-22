/**
 * The files every plugin leaves out of a run because of what they are, not because of a configured glob: the
 * generated ones, the vendored ones, and the ones that are not code when a command ranks only code. Each
 * command reports the counts as `dropped`, so a filter never removes a file without saying how many.
 */
export const DROPPED_KINDS = ["generated", "vendored", "nonCode"] as const;

export type DroppedKind = (typeof DROPPED_KINDS)[number];

const dropped = new Map<DroppedKind, Set<string>>();

/** Notes that a file was left out. A path is counted once per kind however many times it is met. */
export function recordDropped(kind: DroppedKind, path: string): void {
  const paths = dropped.get(kind);
  if (paths === undefined) dropped.set(kind, new Set([path]));
  else paths.add(path);
}

/** Forgets the files left out by an earlier run. Each CLI invocation starts from none. */
export function resetDropped(): void {
  dropped.clear();
  restored.clear();
}

const restored = new Map<DroppedKind, number>();

/**
 * Carries the counts of an earlier run that this run prints from a stored result, so the output still says how
 * many files were left out. It replaces what this run recorded itself, such as the files it listed while checking
 * whether a stored result applied, because the stored counts cover those. `resetDropped` clears them.
 */
export function restoreDropped(counts: Partial<Record<DroppedKind, number>>): void {
  dropped.clear();
  restored.clear();
  for (const kind of DROPPED_KINDS) {
    const count = counts[kind];
    if (typeof count === "number" && count > 0) restored.set(kind, count);
  }
}

/** The number of distinct files left out of this run per kind. Kinds that left out nothing are not listed. */
export function droppedCounts(): Partial<Record<DroppedKind, number>> {
  const counts: Partial<Record<DroppedKind, number>> = {};
  for (const kind of DROPPED_KINDS) {
    const total = (dropped.get(kind)?.size ?? 0) + (restored.get(kind) ?? 0);
    if (total > 0) counts[kind] = total;
  }
  return counts;
}

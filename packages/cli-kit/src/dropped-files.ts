/**
 * The files every plugin leaves out of a run because of what they are, not because of a configured glob: the
 * generated ones, the vendored ones, the ones that are not code when a command ranks only code, and the test files when a command ranks production code first. Each
 * command reports the counts as `dropped`, so a filter never removes a file without saying how many.
 */
export const DROPPED_KINDS = ["generated", "vendored", "nonCode", "tests"] as const;

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
}

/** The number of distinct files left out of this run per kind. Kinds that left out nothing are not listed. */
export function droppedCounts(): Partial<Record<DroppedKind, number>> {
  const counts: Partial<Record<DroppedKind, number>> = {};
  for (const kind of DROPPED_KINDS) {
    const paths = dropped.get(kind);
    if (paths !== undefined && paths.size > 0) counts[kind] = paths.size;
  }
  return counts;
}

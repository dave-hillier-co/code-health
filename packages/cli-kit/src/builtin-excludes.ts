/**
 * The paths every plugin leaves out of its source trees and its history, whatever the config says. The config
 * `exclude` adds to them and does not replace them.
 */
export const BUILTIN_EXCLUDE_GLOBS: readonly string[] = [".claude/**", ".cache/**", ".code-health/**"];

/** The built-in entry for a directory below the repo root that is its own git checkout. */
export const NESTED_CHECKOUT_ENTRY = "<directory below the repo root that contains .git>";

/** Every built-in entry, in the order they are printed. */
export const BUILTIN_EXCLUDE_ENTRIES: readonly string[] = [...BUILTIN_EXCLUDE_GLOBS, NESTED_CHECKOUT_ENTRY];

const omitted = new Map<string, Set<string>>();

/** Notes that a built-in entry omitted a path. A path is counted once per entry however many times it is met. */
export function recordBuiltinOmission(entry: string, path: string): void {
  const paths = omitted.get(entry);
  if (paths === undefined) omitted.set(entry, new Set([path]));
  else paths.add(path);
}

/** Forgets the omissions of an earlier run. Each CLI invocation starts from none. */
export function resetBuiltinOmissions(): void {
  omitted.clear();
  restored.clear();
}

const restored = new Map<string, number>();

/** Carries the counts of an earlier run that this run prints from a stored result, in place of what this run recorded. `resetBuiltinOmissions` clears them. */
export function restoreBuiltinOmissions(counts: Record<string, number>): void {
  omitted.clear();
  restored.clear();
  for (const entry of BUILTIN_EXCLUDE_ENTRIES) {
    const count = counts[entry];
    if (typeof count === "number" && count > 0) restored.set(entry, count);
  }
}

/** The number of distinct paths each built-in entry omitted during this run. Entries that omitted nothing are not listed. */
export function builtinOmissions(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of BUILTIN_EXCLUDE_ENTRIES) {
    const total = (omitted.get(entry)?.size ?? 0) + (restored.get(entry) ?? 0);
    if (total > 0) counts[entry] = total;
  }
  return counts;
}

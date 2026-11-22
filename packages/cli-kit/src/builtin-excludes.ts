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
}

/** The number of distinct paths each built-in entry omitted during this run. Entries that omitted nothing are not listed. */
export function builtinOmissions(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of BUILTIN_EXCLUDE_ENTRIES) {
    const paths = omitted.get(entry);
    if (paths !== undefined && paths.size > 0) counts[entry] = paths.size;
  }
  return counts;
}

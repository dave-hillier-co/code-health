import { configError } from "@code-health/cli-kit/errors";
import { compileGlobs } from "@code-health/history/glob";

/** The group for paths that match no component. */
export const UNASSIGNED = "(unassigned)";

export interface Component {
  name: string;
  matches(path: string): boolean;
}

/**
 * Reads the shared `components` config: a name for each group, mapped to a glob
 * or an array of globs. Components are ordered by name in UTF-8 byte order so
 * that a path matching several belongs to the same one however the file orders its keys.
 */
export function readComponents(value: Record<string, unknown>): Component[] {
  const names = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return names.map((name) => {
    if (name === UNASSIGNED) throw configError(`code-health.json: components.${name} is a reserved name`);
    const raw = value[name];
    const globs = typeof raw === "string" ? [raw] : raw;
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) {
      throw configError(`code-health.json: components.${name} must be a glob or an array of globs`);
    }
    if (globs.length === 0) throw configError(`code-health.json: components.${name} must list at least one glob`);
    return { name, matches: compileGlobs(globs as string[]) };
  });
}

/** The component a path belongs to, or the unassigned group. */
export function componentOf(components: readonly Component[], path: string): string {
  return components.find((c) => c.matches(path))?.name ?? UNASSIGNED;
}

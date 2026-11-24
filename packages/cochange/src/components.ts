import { configError } from "@code-health/cli-kit/errors";
import { compileGlobs } from "@code-health/history/glob";

/** The group for paths that match no component. */
export const UNASSIGNED = "(unassigned)";

export interface Component {
  name: string;
  /** The independent tree the component belongs to, such as `src`, `test` or `samples`; `null` when the config states none. */
  group: string | null;
  /** The globs the component is configured with. */
  globs: string[];
  matches(path: string): boolean;
}

/** What assigning a path to a component needs: the name and the match. */
export type ComponentMatcher = Pick<Component, "name" | "matches">;

/**
 * Reads the shared `components` config: a name for each component, mapped to a glob, an array of globs, or an object
 * `{ "paths": glob or globs, "group": name }` whose group names the independent tree the component belongs to. Components are ordered by name in UTF-8 byte order so
 * that a path matching several belongs to the same one however the file orders its keys.
 */
export function readComponents(value: Record<string, unknown>): Component[] {
  const names = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return names.map((name) => {
    if (name === UNASSIGNED) throw configError(`code-health.json: components.${name} is a reserved name`);
    const raw = value[name];
    const stated = typeof raw === "object" && raw !== null && !Array.isArray(raw);
    const paths = stated ? (raw as Record<string, unknown>).paths : raw;
    const group = stated ? (raw as Record<string, unknown>).group : undefined;
    if (group !== undefined && (typeof group !== "string" || group === "")) {
      throw configError(`code-health.json: components.${name}.group must be a non-empty string`);
    }
    const globs = typeof paths === "string" ? [paths] : paths;
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) {
      throw configError(`code-health.json: components.${name} must be a glob, an array of globs, or an object with "paths"`);
    }
    if (globs.length === 0) throw configError(`code-health.json: components.${name} must list at least one glob`);
    return { name, group: group ?? null, globs: globs as string[], matches: compileGlobs(globs as string[]) };
  });
}

/** The component a path belongs to, or the unassigned group. */
export function componentOf(components: readonly ComponentMatcher[], path: string): string {
  return components.find((c) => c.matches(path))?.name ?? UNASSIGNED;
}

import { posix } from "node:path";
import type { IncludeResolution, Unresolved } from "./resolved-dependencies.ts";
import { isCppPath } from "./languages/cpp/extensions.ts";

/** The share, as a percent, and whether it is above a guideline given in percent. */
export function exceedsUnresolvedGuideline(resolution: IncludeResolution, guidelinePercent: number): boolean {
  return resolution.includes > 0 && resolution.unresolvedShare * 100 > guidelinePercent;
}

/** What a run prints about include resolution: a line for the table, a warning for stderr, and the document section. */
export interface IncludeResolutionReport {
  section: IncludeResolution & { guideline: number; aboveGuideline: boolean };
  /** One sentence for a table run's notices, or undefined when the share is within the guideline. */
  notice: string | undefined;
  /** One sentence for stderr, or undefined when the share is within the guideline. */
  warning: string | undefined;
}

export function describeIncludeResolution(resolution: IncludeResolution, guidelinePercent: number, plugin: string): IncludeResolutionReport {
  const above = exceedsUnresolvedGuideline(resolution, guidelinePercent);
  const share = `${resolution.unresolved} of ${resolution.includes} includes (${(resolution.unresolvedShare * 100).toFixed(1)}%) found no file`;
  const source =
    resolution.compileCommands !== null
      ? `include directories from ${resolution.compileCommands.paths.join(", ")}${resolution.compileCommands.tracked ? "" : " (not tracked by git)"}`
      : resolution.configuredRoots.length > 0
        ? `include directories from the includeRoots setting`
        : resolution.inferredRoots.length > 0
          ? `no compile_commands.json and no includeRoots setting, so ${resolution.inferredRoots.length} include directories were inferred`
          : "no compile_commands.json and no includeRoots setting, and no include directory could be inferred";
  const advice = `${plugin}: set includeRoots in code-health.json, or generate a compile_commands.json (CMAKE_EXPORT_COMPILE_COMMANDS=ON) at the repository root or in build/`;
  const text = `${share}, above the ${plugin}.unresolvedIncludePercent guideline of ${guidelinePercent}% (${source}), so dependencies, consumers and the results that rest on them are incomplete and the affected units are marked low confidence`;
  return {
    section: { ...resolution, guideline: guidelinePercent, aboveGuideline: above },
    notice: above ? text : undefined,
    warning: above ? `Warning: ${text}. ${advice}` : undefined,
  };
}

/**
 * The reason a C or C++ file's results rest on includes that did not resolve, or undefined when none does. A file is low
 * confidence when it has an include of its own that found no file (its dependencies are incomplete), or when a quoted
 * include somewhere names its basename and found no file (a consumer of it may be missing).
 */
export function lowConfidenceReader(unresolved: readonly Unresolved[]): (path: string) => string | undefined {
  const own = new Map<string, number>();
  const named = new Map<string, number>();
  for (const entry of unresolved) {
    if (entry.specifier === null || entry.specifier.startsWith("<") || !isCppPath(entry.from)) continue;
    own.set(entry.from, (own.get(entry.from) ?? 0) + 1);
    const name = posix.basename(entry.specifier);
    named.set(name, (named.get(name) ?? 0) + 1);
  }
  return (path) => {
    if (!isCppPath(path)) return undefined;
    const ownCount = own.get(path) ?? 0;
    const namedCount = named.get(posix.basename(path)) ?? 0;
    if (ownCount === 0 && namedCount === 0) return undefined;
    const parts = [
      ...(ownCount > 0 ? [`${ownCount} of its own includes found no file`] : []),
      ...(namedCount > 0 ? [`${namedCount} includes of a file named ${posix.basename(path)} found no file, so a consumer may be missing`] : []),
    ];
    return parts.join("; ");
  };
}

/**
 * The built-in paths of generated code, as globs with the syntax of `exclude`: minified scripts and stylesheets, and
 * every path with a segment named `generated` (a folder of that name covers everything below it). A path is generated
 * by them only when `.gitattributes` says nothing about it and no entry of the configured `generatedPatterns` matches it.
 */
export const BUILTIN_GENERATED_GLOBS: readonly string[] = ["*.min.js", "*.min.css", "generated"];

let configured: readonly string[] = [];

/**
 * Sets the config's `generatedPatterns` for this run. Every source tree and every history the run reads classifies its
 * files with them, so they are set once, from the loaded config, before the command runs.
 */
export function useGeneratedPatterns(patterns: readonly string[]): void {
  configured = [...patterns];
}

/** The `generatedPatterns` of this run. Empty until a run sets them. */
export function generatedPatterns(): readonly string[] {
  return configured;
}

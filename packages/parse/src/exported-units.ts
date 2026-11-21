import type { FileFacts } from "./facts.ts";

/**
 * Qualified names of the units a file exposes: those its export statements name, and in the symbol-based
 * languages those declared public. Internal exports are not listed.
 */
export function exportedUnitNames(facts: FileFacts): Set<string | undefined> {
  return new Set([
    ...facts.exports.filter((exported) => exported.internal !== true).map((exported) => exported.local),
    ...(facts.symbols?.declarations ?? []).filter((declaration) => declaration.exported).map((declaration) => declaration.unit),
  ]);
}

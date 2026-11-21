import type { LanguageAdapter } from "@code-health/parse/language-adapter";
import { adapterForPath, supportedAdapters } from "@code-health/parse/languages";
import type { MoverLanguage } from "./mover-language.ts";
import * as registered from "./registered-languages.ts";

export const moverLanguages: readonly MoverLanguage[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * The mover language of the adapter that claims a path. Adapters of one dependency group (Java and Kotlin)
 * share one graph, so a move of a file of either rewrites references in both, and the first of the group, in id
 * order, owns the mover.
 */
export function moverFor(path: string, adapters?: readonly LanguageAdapter[], movers: readonly MoverLanguage[] = moverLanguages): MoverLanguage | undefined {
  const adapter = adapterForPath(path, adapters);
  if (adapter === undefined) return undefined;
  const group = adapter.dependencies.group ?? adapter.id;
  const members = (adapters ?? supportedAdapters()).filter((candidate) => (candidate.dependencies.group ?? candidate.id) === group);
  const leader = [...members, adapter].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!;
  return movers.find((language) => language.id === leader.id);
}

/** True for a source file a mover reads and rewrites: its adapter's `mover.sourceExtensions` include its extension. */
export function isSourceFile(path: string): boolean {
  return supportedAdapters().some((adapter) => adapter.mover.sourceExtensions.some((extension) => path.endsWith(extension)));
}

import type { PackageEntries } from "./entries.ts";
import type { PackageModel } from "./model.ts";
import type { PackagingLanguage } from "./packaging-language.ts";
import * as registered from "./registered-languages.ts";

export const packagingLanguages: readonly PackagingLanguage[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Reads the entry files of the packages the structural layer can read, each through the packaging language
 * of its ecosystem. A package no language reads has no entry.
 */
export async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const entries = new Map<string, PackageEntries>();
  for (const language of packagingLanguages) {
    for (const [id, found] of await language.readEntries(model)) entries.set(id, found);
  }
  return entries;
}

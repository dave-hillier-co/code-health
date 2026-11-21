import type { PackageModel } from "./model.ts";
import { packagingLanguages } from "./language.ts";

/** The files through which a package is meant to be used. */
export interface PackageEntries {
  id: string;
  /** Files a consumer may import: what `exports`, `main` or `module` name. */
  files: ReadonlySet<string>;
  /** The package's `exports` map has a pattern, such as `./*`, so any file it matches is public. */
  wildcard: boolean;
  /** The manifest limits its public files with `exports`. Without it, every path under the package can be imported. */
  hasExportsMap: boolean;
}

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

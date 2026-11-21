import type { PackageEntries } from "./entries.ts";
import type { Finding, FindingContext } from "./findings.ts";
import type { PackageModel } from "./model.ts";
import type { ReuseAnalysis } from "./reuse.ts";
import * as registered from "./registered-languages.ts";

/**
 * What the packaging skill needs of one language beyond the structural layer's adapter. A language is one
 * file in `languages/<id>.ts` and one line in `registered-languages.ts`. The `id` is the adapter's.
 */
export interface PackagingLanguage {
  id: string;
  /**
   * The entry files of every package of this language's ecosystems that has code the adapter reads,
   * by package id. Packages it cannot read are left out and reported as unavailable.
   */
  readEntries(model: PackageModel): Promise<Map<string, PackageEntries>>;
  /** What each package's manifest declares against what its code uses: undeclared and unused dependencies. */
  manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]>;
}

export const packagingLanguages: readonly PackagingLanguage[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

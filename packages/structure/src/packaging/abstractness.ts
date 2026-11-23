import { adapterForPath } from "@code-health/parse/languages";
import { round3 } from "../stability.ts";
import type { ReuseAnalysis } from "./reuse-profile.ts";

/** Martin's `A`, from the exported types of a package. */
export interface Abstractness {
  /** Exported interfaces, abstract classes, classes and enums. Type aliases and functions are not types here. */
  exportedTypes: number;
  /** Of them, the interfaces and abstract classes. */
  abstractTypes: number;
  /** `abstractTypes / exportedTypes`, and 0 for a package that exports no type. */
  value: number;
  /** Too few exported types for `A` to say much, as in code that is mostly functions or structurally typed. Change evidence then carries the judgement. */
  weak: boolean;
}


/**
 * Abstractness of every package, weak below `minExportedTypes` exported types (`structure.packages.minExportedTypes`);
 * every package the structural layer could read. Which declarations are types and which
 * are abstract is the adapter's of each element's file. Type aliases are left out of both counts: counted
 * as abstract they would make any package of types look fully abstract.
 */
export function measureAbstractness(reuse: ReuseAnalysis, minExportedTypes: number): Map<string, Abstractness> {
  const result = new Map<string, Abstractness>();
  for (const [id, profile] of reuse.profiles) {
    let types = 0;
    let abstractCount = 0;
    for (const element of profile.surface) {
      const detection = adapterForPath(element.file)?.abstractTypes;
      if (element.kind === null || detection === undefined || !detection.typeKinds.includes(element.kind)) continue;
      types++;
      if (detection.abstractKinds.includes(element.kind)) abstractCount++;
    }
    result.set(id, {
      exportedTypes: types,
      abstractTypes: abstractCount,
      value: types === 0 ? 0 : round3(abstractCount / types),
      weak: types < minExportedTypes,
    });
  }
  return result;
}

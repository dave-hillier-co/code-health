import type { DeclarationKind } from "@code-health/parse/facts";
import { round3 } from "../stability.ts";
import type { ReuseAnalysis } from "./reuse.ts";

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

/** Below this many exported types `A` is reported with a caveat. */
export const WEAK_BELOW_TYPES = 3;

const abstractKinds = new Set(["interface", "abstract-class"]);
const typeKinds = new Set(["interface", "abstract-class", "class", "enum"]);

/**
 * Abstractness of every package the structural layer could read. Type aliases are left out of both
 * counts: counted as abstract they would make any package of types look fully abstract.
 */
export function measureAbstractness(reuse: ReuseAnalysis): Map<string, Abstractness> {
  const result = new Map<string, Abstractness>();
  for (const [id, profile] of reuse.profiles) {
    const kinds = profile.surface.map((element) => element.kind).filter((kind): kind is DeclarationKind => kind !== null && typeKinds.has(kind));
    const abstract = kinds.filter((kind) => abstractKinds.has(kind)).length;
    result.set(id, {
      exportedTypes: kinds.length,
      abstractTypes: abstract,
      value: kinds.length === 0 ? 0 : round3(abstract / kinds.length),
      weak: kinds.length < WEAK_BELOW_TYPES,
    });
  }
  return result;
}

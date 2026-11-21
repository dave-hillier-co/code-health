import type { DeclarationKind } from "@code-health/parse/facts";
import type { PackageEntries } from "./entries.ts";

/** One thing a package lets others use: an exported name, followed to where it is defined. */
export interface SurfaceElement {
  /** `file#name` of the definition, the name its defining file exports it under. */
  key: string;
  file: string;
  name: string;
  /** Qualified name of the defining function or class, when it is one. */
  symbol: string | null;
  /** What it is declared as: an interface, an abstract class, a function, and so on. */
  kind: DeclarationKind | null;
  /** The names the package's entry files export it under. */
  exportedAs: string[];
}

export interface ConsumerUse {
  package: string;
  /** Surface elements it references. */
  used: string[];
  /** Share of the surface it uses. */
  share: number;
}

/** Exports that belong together: used by the same consumers, or referring to each other. */
export interface ExportComponent {
  exports: string[];
  /** Packages using any of them. */
  consumers: string[];
}

export interface ReuseProfile {
  package: string;
  entries: PackageEntries;
  surface: SurfaceElement[];
  consumers: ConsumerUse[];
  /** The middle consumer's share of the surface. Null with no consumer. */
  medianShare: number | null;
  /** Surface elements no other package uses. */
  unused: string[];
  components: ExportComponent[];
  /** Share of the surface that is defined in another package and only passed along. */
  passThroughShare: number;
  /** Uses of the package's files that are not on its surface: past its entry points. */
  deepUses: { from: string; to: string; package: string }[];
}

export interface ReuseAnalysis {
  /** The packages the structural layer could read, with their profiles. */
  profiles: ReadonlyMap<string, ReuseProfile>;
  /** The packages it could not: no adapter for their language, or no code. */
  unavailable: { package: string; reason: string }[];
}

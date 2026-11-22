import type { DeclarationKind } from "./facts.ts";
import type { IncludeResolution } from "./include-resolution.ts";

export interface ImportEdge {
  from: string;
  to: string;
  kind: "import" | "reexport" | "require";
  typeOnly: boolean;
  /**
   * C++ only: the edge from a header to the source file that implements it. It stands for the pair being one unit, and is
   * no dependency of the header on the source, so a view of what depends on what (cycles, package dependencies) leaves it out.
   */
  pairing?: true;
}

export type ConsumerKind = "call" | "reference" | "test";

/** Uses of one definition from one place, with barrels already followed to the definition. */
export interface Consumer {
  from: string;
  /** Qualified name of the unit the use sits in, when it is inside one. */
  fromUnit?: string;
  /** The file that defines what is used. */
  to: string;
  /** Qualified name of the used unit, when the definition is a unit. */
  toSymbol?: string;
  /** Name the defining file exports it under, or the member used when the module's exports are not statically known. */
  toExport: string;
  kind: ConsumerKind;
  count: number;
}

export interface FileEdge {
  from: string;
  to: string;
  /** `test` when the consumer is a test file, otherwise `call` when any use is a direct call. */
  kind: ConsumerKind;
  calls: number;
  references: number;
}

export type UnresolvedReason = "dynamic-import" | "not-found" | "export-not-found";

export interface Unresolved {
  from: string;
  line: number;
  specifier: string | null;
  reason: UnresolvedReason;
}

/** One name a file makes available, with re-exports, renames and star exports followed to where it is defined. */
export interface ExportedName {
  /** The file that exports it. */
  file: string;
  /** The name it is exported under, `default` included. */
  name: string;
  defined: {
    /** The file that defines it. */
    file: string;
    /** The name the defining file exports it under. */
    name: string;
    /** Qualified name of the defining unit, when the definition is a function or class. */
    symbol?: string;
    /** What the definition is declared as: an interface, an abstract class, a class, a function, and so on. */
    kind?: DeclarationKind;
  };
}

/** A file importing, or re-exporting from, a package outside the tree. */
export interface ExternalImport {
  from: string;
  /** The package, with any subpath folded into it: `@scope/pkg/sub` is `@scope/pkg`. */
  packageName: string;
  typeOnly: boolean;
}

/** What a dependency model derives from the facts: everything in a `ProjectAnalysis` that resolution decides. */
export interface ResolvedDependencies {
  /** Static import and re-export statements between files of the tree. */
  importEdges: ImportEdge[];
  consumers: Consumer[];
  /** Dependencies by defining file, with barrels followed through. */
  fileEdges: FileEdge[];
  /** Files that only re-export, each a candidate for removal. */
  barrels: string[];
  /** Everything each file exports, resolved to its definition. Exports of CommonJS and other opaque files are not listed. */
  exports: ExportedName[];
  /** Imports of packages outside the tree. Node's own modules are not among them. */
  externalImports: ExternalImport[];
  unresolved: Unresolved[];
  /** C and C++ only: where the include directories came from and how many includes found no file. Absent for other languages. */
  includeResolution?: IncludeResolution;
}

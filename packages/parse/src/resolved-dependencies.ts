import type { DeclarationKind } from "./facts.ts";

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
  /**
   * Rust only: the statement names the other file and the code of this file does not depend on it. It is a `mod name;`
   * declaration, which places the file in the module tree, or a `pub use` that passes a name along without using it.
   * A view of what depends on what inside one package (cycles) leaves it out.
   */
  nominal?: true;
  /**
   * Rust only: the file of the module the statement's path names, when the edge runs on to a definition another file
   * holds (`use facade::Name`, where the crate `facade` re-exports `Name` from another crate). A view of which package
   * uses which reads it in place of `to`: a statement uses the package it names.
   */
  via?: string;
  /** Every statement behind the edge is test code inside a file that is not a test file by its name, such as a `use` in a Rust `#[cfg(test)]` module. Absent otherwise. */
  test?: true;
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
  /** `test` when the consumer is a test file or only its test code uses the other file, otherwise `call` when any use is a direct call. */
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
  /** `export-not-found` only: the name that was not found. */
  name?: string;
  /** `export-not-found` only: the file the specifier names, whose exports do not have the name. A consumer of that file, or of a file it re-exports, is missing. */
  to?: string;
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

/**
 * How `#include` was resolved for the C and C++ files of a tree, so that a reader knows whether the include graph
 * can be trusted: where the include directories came from, and how many includes still found no file.
 */
export interface IncludeResolution {
  /** The `compile_commands.json` the directories came from, or null when none was read. `tracked` is false for one read from disk that git does not track. */
  compileCommands: { paths: string[]; tracked: boolean } | null;
  /** The directories the config `includeRoots` named, repo-relative, "" for the root. */
  configuredRoots: string[];
  /** The directories inferred from where the unresolved includes' files are, which happens only when there is neither a `compile_commands.json` nor a configured root. */
  inferredRoots: string[];
  /** Includes that name a file of the repository or look for one: every quoted include, and every angle include that resolved. */
  includes: number;
  /** Quoted includes that found no file. They make no edge. */
  unresolved: number;
  /** `unresolved` over `includes`, 0 to 1, rounded to four decimals. 0 when there are no includes. */
  unresolvedShare: number;
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

/**
 * What the TypeScript/JavaScript adapter extracts from one file. Facts depend
 * only on the file's content, never on its path, so they are cached by blob
 * SHA and reused wherever the same content appears.
 */

import type { UnitKind, UnitShape } from "@code-health/lexical/unit";

export type { UnitKind } from "@code-health/lexical/unit";

/** A source unit: the shared `UnitShape`, structural, minus the path. */
export interface UnitFact extends UnitShape {
  /** Qualified name within the file, such as `Widget.render`, with `~n` on later duplicates. */
  qualifiedName: string;
  kind: UnitKind;
  /** Decorators are not part of the range. */
  source: "structural";
}

export interface BindingFact {
  /** Name exported by the module: `default`, a name, or `*` for the whole module. */
  imported: string;
  local: string;
  typeOnly: boolean;
}

export interface ImportFact {
  /** The module specifier, or null for a dynamic `import()` whose argument is not a string literal. */
  specifier: string | null;
  kind: "import" | "require" | "dynamic";
  typeOnly: boolean;
  line: number;
  bindings: BindingFact[];
}

/** One name re-exported from another module. */
export interface ReexportFact {
  specifier: string;
  typeOnly: boolean;
  line: number;
  /** Name in the source module, or `*` for everything. */
  imported: string;
  /** Name exported from this module, or `*` when everything is passed through under its own names. */
  exported: string;
}

export interface ExportFact {
  exported: string;
  /** The local binding or unit that is exported, when the export names one. */
  local?: string;
  line: number;
}

export interface ReferenceFact {
  /** Local name of an imported binding. */
  local: string;
  /** For `ns.member` uses of a namespace import, the member. */
  member?: string;
  kind: "call" | "reference";
  line: number;
  /** Qualified name of the innermost enclosing unit. */
  inUnit?: string;
}

export interface FileFacts {
  units: UnitFact[];
  imports: ImportFact[];
  reexports: ReexportFact[];
  exports: ExportFact[];
  references: ReferenceFact[];
  /** True when the grammar reported syntax errors, so facts may be incomplete. */
  hasSyntaxErrors: boolean;
}

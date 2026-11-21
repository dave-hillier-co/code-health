/**
 * What the TypeScript/JavaScript adapter extracts from one file. Facts depend
 * only on the file's content, never on its path, so they are cached by blob
 * SHA and reused wherever the same content appears.
 */

import type { UnitKind, UnitShape } from "@code-health/lexical/unit";

export type { UnitKind } from "@code-health/lexical/unit";

/** Structural metrics of one function. Definitions are in unit-metrics.ts. */
export interface UnitMetrics {
  /** One per `case`. */
  cyclomatic: number;
  /** One per `switch`, the modified mode. */
  cyclomaticModified: number;
  cognitive: number;
  nesting: number;
  /** Lines holding code, blank and comment-only lines left out. */
  length: number;
  statements: number;
  parameters: number;
  /** Properties destructured out of object parameters. */
  optionCount: number;
}

/** Where one part of a metric came from, for `explain`. */
export interface Increment {
  line: number;
  metric: "cyclomatic" | "cognitive";
  /** The construct, such as `if`, `else if`, `sequence of &&` or `recursion`. */
  construct: string;
  amount: number;
  /** The nesting level that added to a cognitive increment. */
  nesting: number;
  /** Set on the cyclomatic increments that only one `cyclomaticSwitch` mode counts: a `case`, or a whole `switch`. */
  switchMode?: "case" | "modified";
}

/** A source unit: the shared `UnitShape`, structural, minus the path. */
export interface UnitFact extends UnitShape {
  /** Qualified name within the file, such as `Widget.render`, with `~n` on later duplicates. */
  qualifiedName: string;
  kind: UnitKind;
  /** Decorators are not part of the range. */
  source: "structural";
  /** Functions only: classes have none. */
  metrics?: UnitMetrics;
  /** Only when the facts were extracted to explain a unit, never cached. */
  increments?: Increment[];
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

/** What a top-level declaration declares, for the exports that name it. Type-only declarations are `interface` and `type`. */
export type DeclarationKind = "interface" | "abstract-class" | "class" | "enum" | "type" | "function" | "variable" | "namespace";

export interface ExportFact {
  exported: string;
  /** What the exported name is declared as in this file, when it is declared here. Absent for re-exports and names the file does not declare. */
  kind?: DeclarationKind;
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

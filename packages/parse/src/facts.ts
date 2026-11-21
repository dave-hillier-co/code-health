/**
 * What a language adapter extracts from one file. Facts depend
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
  /** Implementation size in syntax nodes and interface size, for the interface depth signal. */
  shape?: { nodes: number; interfaceSize: number };
  /** The call the function's whole body forwards to, as written, when it does nothing else. */
  passThrough?: string;
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

/** A name a file declares, for the symbol-based dependency model. */
export interface SymbolDeclaration {
  /** Fully qualified, as other files write it once the scopes are applied: `Acme.Billing.Invoice`. */
  name: string;
  kind: DeclarationKind;
  /** Qualified name within the file of the unit that is the declaration, when it is one. Partial declarations in several files each name their own. */
  unit?: string;
  /** Part of the file's public surface (public or exported, or visible outside its package). */
  exported: boolean;
  line: number;
}

export interface SymbolReference {
  /** The name as written, which may be qualified: `Invoice`, `Billing.Invoice`. */
  name: string;
  kind: "call" | "reference";
  line: number;
  /** Qualified name of the innermost enclosing unit. */
  inUnit?: string;
}

/** The declarations, scopes and references of a file in a language that names no file in its dependency statements. */
export interface SymbolFacts {
  /** Namespaces or packages the file declares into. Names resolve through them and their parents. */
  namespaces: string[];
  /** Namespaces the file brings into scope (`using`, imports), and same-package names a language makes visible. */
  uses: string[];
  declarations: SymbolDeclaration[];
  references: SymbolReference[];
}

/** Code a macro generates, which a grammar that does not run the preprocessor cannot see. */
export interface MacroFact {
  line: number;
  /** The macro invoked where a declaration belongs, or defined with a body that holds declarations or statements. */
  name: string;
  kind: "invocation" | "definition";
}

export interface FileFacts {
  units: UnitFact[];
  imports: ImportFact[];
  reexports: ReexportFact[];
  exports: ExportFact[];
  references: ReferenceFact[];
  /** Symbol-based languages only. Import-based languages leave it out. */
  symbols?: SymbolFacts;
  /** Languages with a preprocessor only: where macros stand in for code. Left out when there are none. */
  macroGenerated?: MacroFact[];
  /** Named syntax nodes of the whole file, import statements and comments left out. */
  nodes: number;
  /** True when the grammar reported syntax errors, so facts may be incomplete. */
  hasSyntaxErrors: boolean;
}

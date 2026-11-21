import type { Node } from "web-tree-sitter";
import type { ResolvedDependencies } from "./analyse-tree.ts";
import type { FileCensus } from "./census-facts.ts";
import type { DeclarationKind, FileFacts } from "./facts.ts";
import type { MetricRules } from "./metric-rules.ts";
import type { SourceTree } from "./source-tree.ts";

/**
 * The contract between a programming language and the structural layer. A language is one `LanguageAdapter`
 * in `languages/<id>/adapter.ts`, registered by one line in `registered-adapters.ts`. Every plugin that
 * needs something language specific asks the registry (`languages.ts`) and never names a language.
 *
 * What an adapter provides, and who consumes it:
 *
 * | Member | Consumed by |
 * |---|---|
 * | `grammars`, `extract`, `extractorVersion` | every parsing plugin, through `analyseTree` and the parse cache |
 * | `isTestPath` | every plugin that separates production code from tests |
 * | `metrics` | complexity: the construct mapping behind cyclomatic, cognitive, nesting, length, parameters |
 * | `dependencies` | locality and structure: file and symbol dependency edges, with consumer kinds |
 * | `boundaries` | locality (fixed points, published entries) and structure (package of a file) |
 * | `census` | structure census: the syntactic facts the detectors judge |
 * | `packaging`, `abstractTypes` | structure packaging: which packages the adapter reads, and abstractness |
 * | `mover` | locality: how files of the language are moved and how references are confirmed |
 *
 * Plugin-owned vocabulary (census detectors, packaging manifest checks, mover backends, metric rule notes)
 * lives in each plugin, one file per language, keyed by the adapter's `id`. See CONTRIBUTING.md.
 */
export interface LanguageAdapter {
  /** Kebab-case, unique, and the folder name under `fixtures/languages/`. */
  id: string;
  name: string;
  tier: 1 | 2;
  /**
   * `experimental` adapters are registered and tested but are not used to analyse a repository and ship no
   * grammar. `supported` is claimed only when the conformance suites pass for every plugin (suite.md, Tiers).
   */
  support: "experimental" | "supported";
  /** The name of the lexer profile in `@code-health/lexical/profile` whose agreement with this adapter is recorded. */
  lexerProfile: string;
  /** Tree-sitter grammars and the file extensions each parses. */
  grammars: readonly GrammarBinding[];
  /** Bump when extraction changes the facts of the same source, so cached facts are not reused. */
  extractorVersion: number;
  /** Units with qualified names, and the imports, exports, references or symbols that dependency resolution reads. Lines are 1-based. */
  extract(root: Node, options: ExtractOptions): FileFacts;
  /** True for test files, by the language's naming conventions. Asked only about paths the adapter's extensions claim. */
  isTestPath(path: string): boolean;
  metrics: MetricRules;
  dependencies: DependencyResolution;
  boundaries: BoundaryDiscovery;
  /** Reads the syntactic facts the structure census judges. */
  census: CensusExtraction;
  packaging: PackagingInternals;
  abstractTypes: AbstractTypeDetection;
  mover: MoverCapability;
}

export interface GrammarSpec {
  id: string;
  /** npm package that ships the grammar's .wasm file. */
  packageName: string;
  /** File name of the .wasm, both inside the npm package and in `dist/grammars`. */
  file: string;
}

export interface GrammarBinding {
  spec: GrammarSpec;
  /** With the dot, lower case. An extension belongs to one grammar of one adapter. */
  extensions: readonly string[];
}

export interface ExtractOptions {
  /** Function units also carry where their metric increments came from. Cached facts never have them. */
  explain?: boolean;
}

// ---- dependencies ----

export type DependencyModel = "import-based" | "symbol-based";

/** What an import specifier reaches. */
export type Resolution =
  | { kind: "file"; path: string }
  | { kind: "builtin" }
  | { kind: "external"; packageName: string }
  | { kind: "not-found" };

export interface ModuleResolver {
  resolve(from: string, specifier: string): Resolution;
  /**
   * For a language where a name imported from a module may itself be a module (Python `from package import
   * module`): the file of the module `name` inside the module file `modulePath`, when there is one. Asked only
   * when the module does not export the name. TypeScript has no such rule and leaves it out.
   */
  submodule?(modulePath: string, name: string): string | undefined;
}

export interface ResolveInput {
  /** Facts of every file of the adapter's dependency group, by path in UTF-8 byte order. */
  facts: ReadonlyMap<string, FileFacts>;
  /** Every path of the tree, sorted. */
  paths: readonly string[];
  /** Text of the files `isConfigPath` accepts. */
  configs: ReadonlyMap<string, string>;
  isTestPath(path: string): boolean;
}

interface DependencyCommon {
  /** Files the resolver reads (tsconfig, package.json, project files), which `analyseTree` supplies by path. */
  isConfigPath(path: string): boolean;
  /**
   * Adapters with the same group are resolved together by the first of them, so Java and Kotlin share one
   * graph. Defaults to the adapter's own id.
   */
  group?: string;
}

/**
 * A statement names a file or module (TypeScript, Python, Rust `mod` and `use`). The shared import model
 * resolves each `FileFacts.imports`, `reexports` and `exports` entry through the resolver, follows barrels
 * to the definition, and derives file edges and consumers from `references`.
 */
export interface ImportBasedDependencies extends DependencyCommon {
  model: "import-based";
  createResolver(paths: readonly string[], configs: ReadonlyMap<string, string>): ModuleResolver;
}

/**
 * A statement brings in a namespace, or nothing at all (C# `using`, Java and Go same-package references,
 * C++ declarations visible through headers). The shared symbol model builds a table from
 * `FileFacts.symbols.declarations`, resolves `symbols.references` against it through the scopes each
 * file sees, and derives the same edges and consumers. It is heuristic: names are followed without overload
 * or template resolution, which is good enough for ranking. Before any move, references are confirmed with
 * the language's LSP server (see `MoverCapability.confirmation`).
 */
export interface SymbolBasedDependencies extends DependencyCommon {
  model: "symbol-based";
  /** Replaces the shared symbol model when a language needs more (Go packages resolved through `go.mod`). */
  resolve?(input: ResolveInput): ResolvedDependencies;
}

export type DependencyResolution = ImportBasedDependencies | SymbolBasedDependencies;

// ---- boundaries ----

/**
 * A fixed point discovered from a manifest: a unit the build system delivers, such as an npm package, a
 * project file, a Cargo crate or a Go module. The file moves of locality never cross one, and published
 * entries are not moved.
 */
export interface Boundary {
  /** Directory of the manifest, "." for the root. */
  dir: string;
  manifest: string;
  name: string | null;
  /** True when the manifest marks it internal; null when it does not say or could not be read. */
  private: boolean | null;
  /** Files the manifest publishes as entry points, which exist in the tree. Empty for a private boundary. */
  entryFiles: readonly string[];
}

export interface BoundaryDiscovery {
  isManifest(path: string): boolean;
  /** One boundary per readable or unreadable manifest of the tree, sorted by manifest path. */
  discover(tree: SourceTree): Promise<Boundary[]>;
}

// ---- census, packaging, abstract types, mover ----

export interface CensusExtraction {
  extract(root: Node): FileCensus;
}

/**
 * How the structure packaging skill reads packages of this language. Discovery of packages from manifests
 * is the plugin's (`packaging/discovery.ts`), because a manifest names a build system, not a language;
 * this says which discovered ecosystems the adapter can read. The language's internals marker (packaging.md,
 * Languages: `exports`, `internal`, a leading underscore, `internal/`, `pub`) is applied by the plugin's
 * packaging language when it reads a package's entry files, since what a package exposes is the complement.
 */
export interface PackagingInternals {
  /** The `Ecosystem` values of discovered packages whose code this adapter reads. */
  ecosystems: readonly string[];
  /** Names the language in "no <description> for the structural layer to read". */
  description: string;
}

/** Which declaration kinds count as exported types for Martin's abstractness, and which of those are abstract (packaging.md, Languages: interfaces, abstract classes, traits, protocols, pure-virtual classes). */
export interface AbstractTypeDetection {
  typeKinds: readonly DeclarationKind[];
  abstractKinds: readonly DeclarationKind[];
}

export interface ExternalTool {
  /** What it is, as reported: `roslyn-lsp`. */
  name: string;
  /** The executable looked up on the PATH. */
  executable: string;
}

/**
 * What locality can do for the language. The mover backend itself is the plugin's (`movers/<id>.ts`); this
 * descriptor is data that planning and reporting read without loading it.
 */
export interface MoverCapability {
  /**
   * `codemod`: a backend rewrites every reference (ts-morph, rope). `file-move`: the move changes no name,
   * so only the file moves (C# namespaces). `agent`: no deterministic mover, the agent edits and a tool confirms.
   */
  kind: "codemod" | "file-move" | "agent";
  /** Extensions, with the dot, of the files the mover reads and rewrites. */
  sourceExtensions: readonly string[];
  /** An optional external tool that confirms references after a move. Absent at runtime means "not confirmed", never a failure. */
  confirmation: ExternalTool | null;
}

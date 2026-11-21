import type { UnitShape } from "@code-health/lexical/unit";
import { parseFacts } from "./file-facts.ts";
import type { FileFacts, ReferenceFact, UnitKind, UnitMetrics } from "./facts.ts";
import { grammarIdForPath, loadGrammar, type GrammarId, type LoadedGrammar, type LoadOptions } from "./grammars.ts";
import type { ParseCache } from "./parse-cache.ts";
import { isConfigPath, SpecifierResolver, type Resolution } from "./resolve-specifier.ts";
import type { SourceTree } from "./source-tree.ts";

/** A source unit as the structural layer reports it: the shared `UnitShape` (see the lexical package's unit.ts) with a path. */
export interface SourceUnit extends UnitShape {
  /** Repo-relative POSIX path. */
  path: string;
  /** Symbol id: `path#qualifiedName`. */
  id: string;
  /** Qualified name within the file, with `~n` on later duplicates. */
  qualifiedName: string;
  kind: UnitKind;
  /** Structural metrics. Functions only: classes have none. */
  metrics?: UnitMetrics;
  /** Declared with `export` or listed in an export clause at module level. */
  exported: boolean;
}

export interface ImportEdge {
  from: string;
  to: string;
  kind: "import" | "reexport" | "require";
  typeOnly: boolean;
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

export interface ProjectAnalysis {
  units: SourceUnit[];
  /** Static import and re-export statements between files of the tree. */
  importEdges: ImportEdge[];
  consumers: Consumer[];
  /** Dependencies by defining file, with barrels followed through. */
  fileEdges: FileEdge[];
  /** Files that only re-export, each a candidate for removal. */
  barrels: string[];
  unresolved: Unresolved[];
  /** Files whose parse reported syntax errors, so their facts may be incomplete. */
  filesWithSyntaxErrors: string[];
  stats: { parsed: number; cached: number };
}

export interface AnalyseOptions extends LoadOptions {
  cache?: ParseCache;
  /** Decides which files are tests. Defaults to common naming conventions. */
  isTestPath?: (path: string) => boolean;
}

const batchSize = 200;

export async function analyseTree(tree: SourceTree, options: AnalyseOptions = {}): Promise<ProjectAnalysis> {
  const loaded = new Map<string, FileFacts>();
  const stats = { parsed: 0, cached: 0 };
  const grammars = new Map<GrammarId, LoadedGrammar>();
  const pending: string[] = [];

  for (const [path, blob] of tree.files) {
    const id = grammarIdForPath(path);
    if (!id) continue;
    let grammar = grammars.get(id);
    if (!grammar) {
      grammar = await loadGrammar(id, options);
      grammars.set(id, grammar);
    }
    const cached = await options.cache?.get(blob, grammar.version);
    if (cached) {
      loaded.set(path, cached);
      stats.cached++;
    } else {
      pending.push(path);
    }
  }

  for (let start = 0; start < pending.length; start += batchSize) {
    const sources = await tree.readMany(pending.slice(start, start + batchSize));
    for (const [path, source] of sources) {
      const grammar = grammars.get(grammarIdForPath(path) as GrammarId) as LoadedGrammar;
      const fileFacts = parseFacts(grammar, source);
      loaded.set(path, fileFacts);
      stats.parsed++;
      await options.cache?.set(tree.files.get(path) as string, grammar.version, fileFacts);
    }
  }

  // Sorted here, so output order never depends on the order the tree lists its files in.
  const sortedPaths = [...tree.files.keys()].sort(compareUtf8);
  const facts = new Map<string, FileFacts>();
  for (const path of sortedPaths) {
    const fileFacts = loaded.get(path);
    if (fileFacts) facts.set(path, fileFacts);
  }
  const configs = await tree.readMany([...tree.files.keys()].filter(isConfigPath));
  const graph = new GraphBuilder(facts, new SpecifierResolver(sortedPaths, configs), options.isTestPath ?? isTestPath);
  return { ...graph.build(), stats };
}

/** Test files by common naming conventions: `*.test.*`, `*.spec.*` and `test`, `tests`, `__tests__`, `__mocks__` folders. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|__mocks__|tests?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Compares strings by UTF-8 bytes, which is code point order. */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const delta = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (delta !== 0) return delta;
  }
}

type ExportResult =
  | { status: "defined"; file: string; exportName: string; symbol?: string }
  | { status: "namespace"; file: string }
  /** The file's exports are not statically known (CommonJS, JSON, other formats). */
  | { status: "opaque"; file: string }
  | { status: "external" }
  | { status: "missing" };

class GraphBuilder {
  private readonly facts: ReadonlyMap<string, FileFacts>;
  private readonly resolver: SpecifierResolver;
  private readonly isTest: (path: string) => boolean;
  private readonly resolutions = new Map<string, Resolution>();
  private readonly importEdges = new Map<string, ImportEdge>();
  private readonly consumers = new Map<string, Consumer>();
  private readonly fileEdges = new Map<string, FileEdge>();
  private readonly unresolved = new Map<string, Unresolved>();

  constructor(facts: ReadonlyMap<string, FileFacts>, resolver: SpecifierResolver, isTest: (path: string) => boolean) {
    this.facts = facts;
    this.resolver = resolver;
    this.isTest = isTest;
  }

  build(): Omit<ProjectAnalysis, "stats"> {
    const units: SourceUnit[] = [];
    const filesWithSyntaxErrors: string[] = [];
    const barrels: string[] = [];
    for (const [path, fileFacts] of this.facts) {
      if (fileFacts.hasSyntaxErrors) filesWithSyntaxErrors.push(path);
      const exportedLocals = new Set(fileFacts.exports.map((exported) => exported.local));
      for (const unit of fileFacts.units) {
        units.push({
          path,
          id: `${path}#${unit.qualifiedName}`,
          qualifiedName: unit.qualifiedName,
          kind: unit.kind,
          startLine: unit.startLine,
          endLine: unit.endLine,
          source: unit.source,
          ...(unit.parent === undefined ? {} : { parent: unit.parent }),
          ...(unit.metrics === undefined ? {} : { metrics: unit.metrics }),
          exported: unit.parent === undefined && exportedLocals.has(unit.qualifiedName),
        });
      }
      if (this.isBarrel(fileFacts)) barrels.push(path);
      this.fileDependencies(path, fileFacts);
    }
    return {
      units,
      importEdges: [...this.importEdges.values()].sort(
        (a, b) =>
          compareUtf8(a.from, b.from) ||
          compareUtf8(a.to, b.to) ||
          compareUtf8(a.kind, b.kind) ||
          Number(a.typeOnly) - Number(b.typeOnly),
      ),
      consumers: [...this.consumers.values()].sort(
        (a, b) =>
          compareUtf8(a.from, b.from) ||
          compareUtf8(a.fromUnit ?? "", b.fromUnit ?? "") ||
          compareUtf8(a.to, b.to) ||
          compareUtf8(a.toSymbol ?? a.toExport, b.toSymbol ?? b.toExport) ||
          compareUtf8(a.kind, b.kind),
      ),
      fileEdges: [...this.fileEdges.values()].sort((a, b) => compareUtf8(a.from, b.from) || compareUtf8(a.to, b.to)),
      barrels,
      unresolved: [...this.unresolved.values()].sort(
        (a, b) => compareUtf8(a.from, b.from) || a.line - b.line || compareUtf8(a.specifier ?? "", b.specifier ?? ""),
      ),
      filesWithSyntaxErrors,
    };
  }

  /** A file that defines nothing of its own and only passes other modules' exports along. */
  private isBarrel(file: FileFacts): boolean {
    if (file.units.length > 0) return false;
    const imported = new Set(file.imports.flatMap((fact) => fact.bindings.map((binding) => binding.local)));
    const passThrough = file.exports.filter((exported) => exported.local !== undefined && imported.has(exported.local));
    return file.reexports.length + passThrough.length > 0 && passThrough.length === file.exports.length;
  }

  private resolve(from: string, specifier: string): Resolution {
    const key = `${from}\0${specifier}`;
    let resolution = this.resolutions.get(key);
    if (!resolution) {
      resolution = this.resolver.resolve(from, specifier);
      this.resolutions.set(key, resolution);
    }
    return resolution;
  }

  private addUnresolved(from: string, line: number, specifier: string | null, reason: UnresolvedReason): void {
    this.unresolved.set(`${from}\0${line}\0${specifier}\0${reason}`, { from, line, specifier, reason });
  }

  private addImportEdge(from: string, to: string, kind: ImportEdge["kind"], typeOnly: boolean): void {
    this.importEdges.set(`${from}\0${to}\0${kind}\0${typeOnly}`, { from, to, kind, typeOnly });
  }

  private fileDependencies(path: string, file: FileFacts): void {
    for (const reexport of file.reexports) {
      const target = this.resolve(path, reexport.specifier);
      if (target.kind === "file") this.addImportEdge(path, target.path, "reexport", reexport.typeOnly);
      else if (target.kind === "not-found") this.addUnresolved(path, reexport.line, reexport.specifier, "not-found");
    }
    const unitNames = new Set(file.units.map((unit) => unit.qualifiedName));
    const exportedLocals = new Set(file.exports.map((exported) => exported.local));
    for (const imported of file.imports) {
      if (imported.kind === "dynamic") {
        this.addUnresolved(path, imported.line, imported.specifier, "dynamic-import");
        continue;
      }
      if (imported.specifier === null) continue;
      const target = this.resolve(path, imported.specifier);
      if (target.kind === "not-found") this.addUnresolved(path, imported.line, imported.specifier, "not-found");
      if (target.kind !== "file") continue;
      this.addImportEdge(path, target.path, imported.kind === "require" ? "require" : "import", imported.typeOnly);
      if (imported.bindings.length === 0) this.touch(path, target.path);
      for (const binding of imported.bindings) {
        const uses = file.references.filter((reference) => reference.local === binding.local);
        // An import that is only re-exported is a pass-through, not a dependency of this file.
        const passThrough = uses.length === 0 && exportedLocals.has(binding.local);
        if (passThrough) continue;
        if (binding.imported === "*") {
          this.useNamespace(path, target.path, uses, unitNames);
          continue;
        }
        const result = this.resolveExport(target.path, binding.imported, new Set());
        switch (result.status) {
          case "defined":
            this.touch(path, result.file);
            for (const use of uses) {
              this.consume(path, use, unitNames, result.file, result.exportName, result.symbol, false);
            }
            break;
          case "namespace":
            this.useNamespace(path, result.file, uses, unitNames);
            break;
          case "opaque":
            this.touch(path, result.file);
            for (const use of uses) this.consume(path, use, unitNames, result.file, binding.imported, undefined, false);
            break;
          case "missing":
            this.addUnresolved(path, imported.line, imported.specifier, "export-not-found");
            break;
          case "external":
            break;
        }
      }
    }
  }

  /** Records that a file depends on another, even when nothing in it is referenced. */
  private touch(from: string, to: string): FileEdge {
    const key = `${from}\0${to}`;
    let edge = this.fileEdges.get(key);
    if (!edge) {
      edge = { from, to, kind: this.isTest(from) ? "test" : "reference", calls: 0, references: 0 };
      this.fileEdges.set(key, edge);
    }
    return edge;
  }

  private useNamespace(from: string, namespace: string, uses: ReferenceFact[], unitNames: ReadonlySet<string>): void {
    if (uses.length === 0) this.touch(from, namespace);
    for (const use of uses) {
      if (use.member === undefined) {
        this.consume(from, use, unitNames, namespace, "*", undefined, false);
        continue;
      }
      const result = this.resolveExport(namespace, use.member, new Set());
      if (result.status === "defined") {
        this.consume(from, use, unitNames, result.file, result.exportName, result.symbol, true);
      } else {
        const file = result.status === "namespace" || result.status === "opaque" ? result.file : namespace;
        this.consume(from, use, unitNames, file, use.member, undefined, true);
      }
    }
  }

  /**
   * Counts one use. A call counts only when the imported binding itself is
   * called, or the called member of a namespace. `service.method()` on a named
   * import is a use of `service`, so it is another reference.
   */
  private consume(
    from: string,
    use: ReferenceFact,
    unitNames: ReadonlySet<string>,
    to: string,
    toExport: string,
    toSymbol: string | undefined,
    memberOfNamespace: boolean,
  ): void {
    const direct = use.member === undefined || memberOfNamespace;
    const kind = direct ? use.kind : "reference";
    const edge = this.touch(from, to);
    if (kind === "call") edge.calls++;
    else edge.references++;
    if (!this.isTest(from) && kind === "call") edge.kind = "call";
    let fromUnit = use.inUnit;
    while (fromUnit !== undefined && !unitNames.has(fromUnit)) {
      const dot = fromUnit.lastIndexOf(".");
      fromUnit = dot < 0 ? undefined : fromUnit.slice(0, dot);
    }
    const consumerKind = this.isTest(from) ? "test" : kind;
    const key = `${from}\0${fromUnit ?? ""}\0${to}\0${toSymbol ?? toExport}\0${consumerKind}`;
    const existing = this.consumers.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    const consumer: Consumer = { from, to, toExport, kind: consumerKind, count: 1 };
    if (fromUnit !== undefined) consumer.fromUnit = fromUnit;
    if (toSymbol !== undefined) consumer.toSymbol = toSymbol;
    this.consumers.set(key, consumer);
  }

  /** Follows an exported name through re-exports and barrels to the file that defines it. */
  private resolveExport(path: string, name: string, visiting: Set<string>): ExportResult {
    const file = this.facts.get(path);
    if (!file) return { status: "opaque", file: path };
    const key = `${path}\0${name}`;
    if (visiting.has(key)) return { status: "missing" };
    visiting.add(key);

    for (const exported of file.exports) {
      if (exported.exported !== name) continue;
      if (exported.local === undefined) return { status: "defined", file: path, exportName: name };
      const binding = this.importBinding(file, exported.local);
      if (!binding) {
        const unit = file.units.find((candidate) => candidate.qualifiedName === exported.local && !candidate.parent);
        return unit
          ? { status: "defined", file: path, exportName: name, symbol: unit.qualifiedName }
          : { status: "defined", file: path, exportName: name };
      }
      return this.followBinding(path, binding.specifier, binding.imported, visiting);
    }
    for (const reexport of file.reexports) {
      if (reexport.exported === name) return this.followBinding(path, reexport.specifier, reexport.imported, visiting);
    }
    if (name !== "default") {
      for (const reexport of file.reexports) {
        if (reexport.exported !== "*") continue;
        const result = this.followBinding(path, reexport.specifier, name, visiting);
        if (result.status !== "missing") return result;
      }
    }
    return file.exports.length === 0 && file.reexports.length === 0
      ? { status: "opaque", file: path }
      : { status: "missing" };
  }

  private followBinding(from: string, specifier: string, imported: string, visiting: Set<string>): ExportResult {
    const target = this.resolve(from, specifier);
    if (target.kind === "file") {
      return imported === "*"
        ? { status: "namespace", file: target.path }
        : this.resolveExport(target.path, imported, visiting);
    }
    return target.kind === "not-found" ? { status: "missing" } : { status: "external" };
  }

  private importBinding(file: FileFacts, local: string): { specifier: string; imported: string } | undefined {
    for (const imported of file.imports) {
      if (imported.specifier === null || imported.kind === "dynamic") continue;
      const binding = imported.bindings.find((candidate) => candidate.local === local);
      if (binding) return { specifier: imported.specifier, imported: binding.imported };
    }
    return undefined;
  }
}

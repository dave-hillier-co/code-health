import type { ExportedName, Consumer, FileEdge, ImportEdge, ResolvedDependencies, Unresolved, UnresolvedReason, ExternalImport } from "./resolved-dependencies.ts";
import type { FileFacts, ReferenceFact } from "./facts.ts";
import type { ModuleResolver, Resolution } from "./language-adapter.ts";

/**
 * The import-based dependency model: statements name a module, a resolver maps the specifier to a file,
 * and barrels and re-exports are followed to the file that defines each name. Output order is the
 * caller's: `analyseTree` sorts what every model returns.
 */

type ExportResult =
  | { status: "defined"; file: string; exportName: string; symbol?: string }
  /** The module itself, as a whole. `submodule` is set when the name was a module of a package and no export (Python `from package import module`). */
  | { status: "namespace"; file: string; submodule?: true }
  /** The file's exports are not statically known (CommonJS, JSON, other formats). */
  | { status: "opaque"; file: string }
  | { status: "external" }
  | { status: "missing" };

export class ImportModel {
  private readonly facts: ReadonlyMap<string, FileFacts>;
  private readonly resolver: ModuleResolver;
  private readonly isTest: (path: string) => boolean;
  private readonly resolutions = new Map<string, Resolution>();
  private readonly importEdges = new Map<string, ImportEdge>();
  private readonly consumers = new Map<string, Consumer>();
  private readonly fileEdges = new Map<string, FileEdge>();
  private readonly unresolved = new Map<string, Unresolved>();
  private readonly externals = new Map<string, ExternalImport>();

  constructor(facts: ReadonlyMap<string, FileFacts>, resolver: ModuleResolver, isTest: (path: string) => boolean) {
    this.facts = facts;
    this.resolver = resolver;
    this.isTest = isTest;
  }

  build(): ResolvedDependencies {
    const barrels: string[] = [];
    for (const [path, fileFacts] of this.facts) {
      if (this.isBarrel(fileFacts)) barrels.push(path);
      this.fileDependencies(path, fileFacts);
    }
    return {
      importEdges: [...this.importEdges.values()],
      consumers: [...this.consumers.values()],
      fileEdges: [...this.fileEdges.values()],
      barrels,
      exports: this.exportedNames(),
      externalImports: [...this.externals.values()],
      unresolved: [...this.unresolved.values()],
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
    if (from === to && this.resolver.dropsSelfDependencies === true) return;
    this.importEdges.set(`${from}\0${to}\0${kind}\0${typeOnly}`, { from, to, kind, typeOnly });
  }

  private addExternal(from: string, packageName: string, typeOnly: boolean): void {
    this.externals.set(`${from}\0${packageName}\0${typeOnly}`, { from, packageName, typeOnly });
  }

  /** Every name each file exports, followed to its definition. */
  private exportedNames(): ExportedName[] {
    const names: ExportedName[] = [];
    for (const [path] of this.facts) {
      const seen = new Set<string>();
      for (const name of this.namesExportedBy(path, new Set())) {
        if (seen.has(name)) continue;
        seen.add(name);
        const result = this.resolveExport(path, name, new Set());
        if (result.status !== "defined") continue;
        const definition = this.facts.get(result.file)?.exports.find((exported) => exported.exported === result.exportName);
        if (definition?.internal === true) continue;
        const kind = definition?.kind;
        names.push({
          file: path,
          name,
          defined: {
            file: result.file,
            name: result.exportName,
            ...(result.symbol === undefined ? {} : { symbol: result.symbol }),
            ...(kind === undefined ? {} : { kind }),
          },
        });
      }
    }
    return names;
  }

  /** The names a file exports: its own, its named re-exports, and what its star re-exports pass along (never `default`). */
  private namesExportedBy(path: string, visiting: Set<string>): string[] {
    const file = this.facts.get(path);
    if (!file || visiting.has(path)) return [];
    visiting.add(path);
    const names = file.exports.map((exported) => exported.exported);
    for (const reexport of file.reexports) {
      if (reexport.exported !== "*") {
        names.push(reexport.exported);
        continue;
      }
      const target = this.resolve(path, reexport.specifier);
      if (target.kind === "file") names.push(...this.namesExportedBy(target.path, visiting).filter((name) => name !== "default"));
    }
    return names;
  }

  private fileDependencies(path: string, file: FileFacts): void {
    for (const reexport of file.reexports) {
      const target = this.resolve(path, reexport.specifier);
      if (target.kind === "external") this.addExternal(path, target.packageName, reexport.typeOnly);
      if (target.kind === "file") this.addImportEdge(path, target.path, "reexport", reexport.typeOnly);
      else if (target.kind === "not-found") this.addUnresolved(path, reexport.line, reexport.specifier, "not-found");
    }
    const unitNames = new Set(file.units.map((unit) => unit.qualifiedName));
    const implicitIsReexport = this.resolver.reexportsImplicitly?.(path) === true;
    const exportedLocals = new Set(file.exports.filter((exported) => exported.implicit !== true || implicitIsReexport).map((exported) => exported.local));
    for (const imported of file.imports) {
      if (imported.kind === "dynamic") {
        this.addUnresolved(path, imported.line, imported.specifier, "dynamic-import");
        continue;
      }
      if (imported.specifier === null) continue;
      const target = this.resolve(path, imported.specifier);
      if (target.kind === "external") this.addExternal(path, target.packageName, imported.typeOnly);
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
            // A module imported by name from its package is a dependency on that module file, not only on the package.
            if (result.submodule === true) this.addImportEdge(path, result.file, "import", imported.typeOnly);
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
    // The edge of a file to itself is counted into nothing when the language does not want it.
    if (from === to && this.resolver.dropsSelfDependencies === true) return { from, to, kind: "reference", calls: 0, references: 0 };
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
    if (from === to && this.resolver.dropsSelfDependencies === true) return;
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
    const submodule = this.resolver.submodule?.(path, name);
    if (submodule !== undefined) return { status: "namespace", file: submodule, submodule: true };
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

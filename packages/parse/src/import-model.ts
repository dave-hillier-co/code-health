import type { ExportedName, Consumer, FileEdge, ImportEdge, ResolvedDependencies, Unresolved, UnresolvedReason, ExternalImport } from "./resolved-dependencies.ts";
import type { FileFacts, ReexportFact, ReferenceFact } from "./facts.ts";
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
  /** The file's exports are not statically known (CommonJS, JSON, other formats). `guessed` when the file lists exports and a macro it invokes may define more. */
  | { status: "opaque"; file: string; guessed?: true }
  | { status: "external" }
  | { status: "missing" };

/** A glob import of a file whose edges run to definitions: the module's file, and the file the path named before re-exports were followed. */
interface Glob {
  target: string;
  named: string;
  reexport: ReexportFact;
}

/** How many re-exports a name is followed through before it is given up as missing. */
const MAX_CHAIN = 64;
/** How many path resolutions may be in progress inside one another, each waiting on a re-exported module of the next. */
const MAX_NESTED_RESOLUTIONS = 32;

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
  private readonly resolving = new Set<string>();
  private readonly exportResults = new Map<string, ExportResult>();
  private readonly exportsInProgress = new Set<string>();

  constructor(facts: ReadonlyMap<string, FileFacts>, resolver: ModuleResolver, isTest: (path: string) => boolean) {
    this.facts = facts;
    this.resolver = resolver;
    this.isTest = isTest;
    resolver.followReexports?.((file, name) => {
      const result = this.exportOf(file, name);
      if (result.status === "namespace") return result.file;
      if (result.status === "external") return null;
      // A namespace written out inside another file (a Rust inline module) is that file.
      if (result.status === "defined" && this.facts.get(result.file)?.exports.some((exported) => exported.exported === result.exportName && exported.kind === "namespace") === true) return result.file;
      return undefined;
    });
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

  /**
   * A file that defines nothing of its own and only passes other modules' exports along. A namespace written out in the
   * file (a Rust inline module) is not something of its own: what it holds is listed among the file's exports.
   */
  private isBarrel(file: FileFacts): boolean {
    if (file.units.length > 0) return false;
    const imported = new Set(file.imports.flatMap((fact) => fact.bindings.map((binding) => binding.local)));
    const own = file.exports.filter((exported) => !(exported.kind === "namespace" && exported.local === undefined));
    const passThrough = own.filter((exported) => exported.local !== undefined && imported.has(exported.local));
    return file.reexports.length + passThrough.length > 0 && passThrough.length === own.length;
  }

  private resolve(from: string, specifier: string): Resolution {
    const key = `${from}\0${specifier}`;
    let resolution = this.resolutions.get(key);
    if (!resolution) {
      // A resolver that follows re-exports asks this model for them, which may come back to a path still being resolved.
      if (this.resolving.has(key) || this.resolving.size >= MAX_NESTED_RESOLUTIONS) return { kind: "not-found" };
      this.resolving.add(key);
      try {
        resolution = this.resolver.resolve(from, specifier);
      } finally {
        this.resolving.delete(key);
      }
      this.resolutions.set(key, resolution);
    }
    return resolution;
  }

  /** `name` and `to` are given for a name a module does not export: the name, and the module's file. */
  private addUnresolved(from: string, line: number, specifier: string | null, reason: UnresolvedReason, name?: string, to?: string): void {
    this.unresolved.set(`${from}\0${line}\0${specifier}\0${reason}\0${name ?? ""}`, { from, line, specifier, reason, ...(name === undefined ? {} : { name }), ...(to === undefined ? {} : { to }) });
  }

  /** Records an import edge. It is `test` while every statement behind it is test code. */
  private addImportEdge(from: string, to: string, kind: ImportEdge["kind"], typeOnly: boolean, test = false, nominal = false, named?: string): void {
    if (from === to && this.resolver.dropsSelfDependencies === true) return;
    const via = named === to || named === from ? undefined : named;
    const key = `${from}\0${to}\0${kind}\0${typeOnly}\0${nominal}\0${via ?? ""}`;
    const existing = this.importEdges.get(key);
    if (existing !== undefined) {
      if (!test) delete existing.test;
      return;
    }
    this.importEdges.set(key, { from, to, kind, typeOnly, ...(nominal ? { nominal: true as const } : {}), ...(via === undefined ? {} : { via }), ...(test ? { test: true as const } : {}) });
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
        const result = this.exportOf(path, name);
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
      if (reexport.visibility !== undefined) continue;
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
    // Where an edge runs to the definition, a statement makes its edges as its names are followed, not at the module it names.
    const reach = this.resolver.edgesReachDefinitions === true;
    const globs: Glob[] = [];
    for (const reexport of file.reexports) {
      const target = this.resolve(path, reexport.specifier);
      if (target.kind === "external") this.addExternal(path, target.packageName, reexport.typeOnly);
      if (target.kind === "not-found") this.addUnresolved(path, reexport.line, reexport.specifier, "not-found");
      if (target.kind !== "file") continue;
      if (!reach) this.addImportEdge(path, target.path, "reexport", reexport.typeOnly);
      else if (reexport.exported === "*") globs.push({ target: target.path, named: target.via ?? target.path, reexport });
      else {
        const result = this.exportOf(target.path, reexport.imported);
        this.addImportEdge(path, result.status === "defined" || result.status === "namespace" ? result.file : target.path, "reexport", reexport.typeOnly, false, true, target.via ?? target.path);
      }
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
      const test = imported.test === true;
      const kind = imported.kind === "require" ? "require" : "import";
      const declares = imported.declares === true;
      // The module the statement names, before any re-export is followed.
      const named = target.via ?? target.path;
      // An edge is test code when the statement is, or when only test code uses the name it binds.
      let testUse = test;
      const land = (to: string): void => {
        if (reach) this.addImportEdge(path, to, kind, imported.typeOnly, testUse, false, named);
      };
      if (declares) this.addImportEdge(path, target.path, kind, imported.typeOnly, test, true);
      else if (!reach) this.addImportEdge(path, target.path, kind, imported.typeOnly, test);
      if (imported.bindings.length === 0) {
        this.touch(path, target.path, test);
        land(target.path);
      }
      for (const binding of imported.bindings) {
        const uses = file.references.filter((reference) => reference.local === binding.local);
        // A declaration places the module. The file depends on it only where its code names it.
        if (declares && uses.length === 0) continue;
        const onlyTests = uses.length > 0 && uses.every((use) => use.test === true);
        testUse = test || onlyTests;
        // An import that is only re-exported is a pass-through, not a dependency of this file.
        const passThrough = uses.length === 0 && exportedLocals.has(binding.local);
        // Where edges run to definitions, a re-export that only the file's test code also uses is still a pass-through for its production code.
        if (passThrough || (reach && onlyTests && !test && exportedLocals.has(binding.local))) {
          // A submodule imported only to be exposed (`from . import x` in `__init__.py`) is still imported: the package loads it.
          const exposed = binding.imported === "*" ? undefined : this.exportOf(target.path, binding.imported);
          if (exposed?.status === "namespace" && exposed.submodule === true) this.addImportEdge(path, exposed.file, "import", imported.typeOnly, test);
          if (reach) {
            if (exposed === undefined) this.addImportEdge(path, target.path, "reexport", imported.typeOnly, test, true, named);
            else if (exposed.status === "missing" && passThrough) this.addUnresolved(path, imported.line, imported.specifier, "export-not-found", binding.imported, target.path);
            else if (exposed.status !== "external" && exposed.status !== "missing") this.addImportEdge(path, exposed.file, "reexport", imported.typeOnly, test, true, named);
          }
          if (passThrough) continue;
        }
        if (binding.imported === "*") {
          this.useNamespace(path, target.path, uses, unitNames, testUse, land);
          continue;
        }
        const result = this.exportOf(target.path, binding.imported);
        switch (result.status) {
          case "defined":
            this.touch(path, result.file, testUse);
            land(result.file);
            for (const use of uses) {
              this.consume(path, use, unitNames, result.file, result.exportName, result.symbol, false);
            }
            // Where a statement depends on the definition, naming it is a use of it: a trait is imported for its methods, which no name shows.
            if (reach && uses.length === 0) {
              this.consume(path, { local: binding.local, kind: "reference", line: imported.line, ...(test ? { test: true as const } : {}) }, unitNames, result.file, result.exportName, result.symbol, false);
            }
            break;
          case "namespace":
            // A module imported by name from its package is a dependency on that module file, not only on the package.
            if (result.submodule === true) this.addImportEdge(path, result.file, "import", imported.typeOnly, test);
            this.useNamespace(path, result.file, uses, unitNames, testUse, land);
            break;
          case "opaque":
            this.touch(path, result.file, testUse);
            land(result.file);
            for (const use of uses) this.consume(path, use, unitNames, result.file, binding.imported, undefined, false);
            break;
          case "missing":
            this.addUnresolved(path, imported.line, imported.specifier, "export-not-found", binding.imported, target.path);
            break;
          case "external":
            break;
        }
      }
    }
    if (globs.length > 0) this.globDependencies(path, file, globs, unitNames);
  }

  /**
   * The glob imports of a file whose edges run to definitions. A name the file uses and neither declares nor imports
   * is looked up in each glob's module, in order, and is a use of the file that defines it. A glob that is `pub` in
   * any form passes names along, which is a nominal edge. A private one through which no use was found is still an
   * import of its module: what it brings in may be used in a way no name shows, as a trait's methods are.
   */
  private globDependencies(path: string, file: FileFacts, globs: readonly Glob[], unitNames: ReadonlySet<string>): void {
    const used = new Set<number>();
    if (this.resolver.globsBindNames === true) {
      const bound = new Set(file.imports.flatMap((imported) => imported.bindings.map((binding) => binding.local)));
      for (const use of file.references) {
        if (bound.has(use.local)) continue;
        const test = use.test === true;
        for (const [index, glob] of globs.entries()) {
          const land = (to: string): void => this.addImportEdge(path, to, "import", false, test, false, glob.named);
          const result = this.exportOf(glob.target, use.local);
          if (result.status === "defined") {
            this.consume(path, use, unitNames, result.file, result.exportName, result.symbol, false);
            land(result.file);
          } else if (result.status === "namespace") this.useNamespace(path, result.file, [use], unitNames, test, land);
          else continue;
          used.add(index);
          break;
        }
      }
    }
    for (const [index, glob] of globs.entries()) {
      if (glob.reexport.visibility !== "private") this.addImportEdge(path, glob.target, "reexport", glob.reexport.typeOnly, false, true, glob.named);
      else if (!used.has(index)) {
        this.touch(path, glob.target);
        this.addImportEdge(path, glob.target, "import", glob.reexport.typeOnly, false, false, glob.named);
      }
    }
  }

  /**
   * Records that a file depends on another, even when nothing in it is referenced. The edge is `test` when the file is
   * a test, or while only its test code depends on the other.
   */
  private touch(from: string, to: string, test = false): FileEdge {
    // The edge of a file to itself is counted into nothing when the language does not want it.
    if (from === to && this.resolver.dropsSelfDependencies === true) return { from, to, kind: "reference", calls: 0, references: 0 };
    const key = `${from}\0${to}`;
    const testUse = test || this.isTest(from);
    let edge = this.fileEdges.get(key);
    if (!edge) {
      edge = { from, to, kind: testUse ? "test" : "reference", calls: 0, references: 0 };
      this.fileEdges.set(key, edge);
    } else if (!testUse && edge.kind === "test") edge.kind = "reference";
    return edge;
  }

  /** Counts the uses of a module imported whole. `land` is told each file a use reaches. */
  private useNamespace(from: string, namespace: string, uses: ReferenceFact[], unitNames: ReadonlySet<string>, test: boolean, land: (to: string) => void = () => {}): void {
    if (uses.length === 0) {
      this.touch(from, namespace, test);
      land(namespace);
    }
    for (const use of uses) {
      if (use.member === undefined) {
        this.consume(from, use, unitNames, namespace, "*", undefined, false);
        land(namespace);
        continue;
      }
      const result = this.exportOf(namespace, use.member);
      if (result.status === "defined") {
        this.consume(from, use, unitNames, result.file, result.exportName, result.symbol, true);
        land(result.file);
      } else {
        const file = result.status === "namespace" || result.status === "opaque" ? result.file : namespace;
        this.consume(from, use, unitNames, file, use.member, undefined, true);
        land(file);
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
    const testUse = this.isTest(from) || use.test === true;
    const edge = this.touch(from, to, testUse);
    if (kind === "call") edge.calls++;
    else edge.references++;
    if (!testUse && kind === "call") edge.kind = "call";
    let fromUnit = use.inUnit;
    while (fromUnit !== undefined && !unitNames.has(fromUnit)) {
      const dot = fromUnit.lastIndexOf(".");
      fromUnit = dot < 0 ? undefined : fromUnit.slice(0, dot);
    }
    const consumerKind = testUse ? "test" : kind;
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

  /** What a name exported by a file is, followed to its definition. Each answer is worked out once. */
  private exportOf(path: string, name: string): ExportResult {
    const key = `${path}\0${name}`;
    const known = this.exportResults.get(key);
    if (known !== undefined) return known;
    if (this.exportsInProgress.has(key)) return { status: "missing" };
    this.exportsInProgress.add(key);
    try {
      const result = this.resolveExport(path, name, new Set());
      this.exportResults.set(key, result);
      return result;
    } finally {
      this.exportsInProgress.delete(key);
    }
  }

  /** Follows an exported name through re-exports and barrels to the file that defines it. */
  private resolveExport(path: string, name: string, visiting: Set<string>): ExportResult {
    const file = this.facts.get(path);
    if (!file) return { status: "opaque", file: path };
    const key = `${path}\0${name}`;
    if (visiting.has(key) || visiting.size >= MAX_CHAIN) return { status: "missing" };
    visiting.add(key);

    for (const exported of file.exports) {
      if (exported.exported !== name) continue;
      if (exported.local === undefined) return { status: "defined", file: path, exportName: name };
      // A unit of the file is the definition, whatever an inner scope imports under the same name (a Rust test module's `use crate::Name`).
      const unit = file.units.find((candidate) => candidate.qualifiedName === exported.local && !candidate.parent);
      if (unit) return { status: "defined", file: path, exportName: name, symbol: unit.qualifiedName };
      const binding = this.importBinding(file, exported.local);
      if (!binding) return { status: "defined", file: path, exportName: name };
      // `from . import name` inside a package's own `__init__`: the name is imported from the file itself, so it is a submodule, not an export.
      const target = this.resolve(path, binding.specifier);
      if (target.kind === "file" && target.path === path && binding.imported === name) continue;
      return this.followBinding(path, binding.specifier, binding.imported, visiting);
    }
    for (const reexport of file.reexports) {
      if (reexport.exported === name) return this.followBinding(path, reexport.specifier, reexport.imported, visiting);
    }
    // A star that may hold the name without listing it (a module outside the tree, a file whose macros define names)
    // is the answer only when nothing lists it.
    let unlisted: ExportResult | undefined;
    if (name !== "default") {
      for (const reexport of file.reexports) {
        if (reexport.exported !== "*") continue;
        const result = this.followBinding(path, reexport.specifier, name, visiting);
        if (result.status === "missing") continue;
        if (result.status === "external" || (result.status === "opaque" && result.guessed === true)) unlisted ??= result;
        else return result;
      }
    }
    if (this.resolver.importsAreVisible === true) {
      const binding = this.importBinding(file, name);
      if (binding) return this.followBinding(path, binding.specifier, binding.imported, visiting);
    }
    const elsewhere = this.resolver.exportedElsewhere?.(path, name);
    if (elsewhere !== undefined) return this.resolveExport(elsewhere.file, elsewhere.name, visiting);
    const submodule = this.resolver.submodule?.(path, name);
    if (submodule !== undefined) return { status: "namespace", file: submodule, submodule: true };
    // A macro the file invokes where an item belongs may define the name.
    if (file.itemMacros === true) return { status: "opaque", file: path, guessed: true };
    if (unlisted !== undefined) return unlisted;
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

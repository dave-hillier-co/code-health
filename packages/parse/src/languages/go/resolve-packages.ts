import { posix } from "node:path";
import type { ExternalImport, ResolvedDependencies, Unresolved } from "../../analyse-tree.ts";
import type { FileFacts, SymbolDeclaration, SymbolReference } from "../../facts.ts";
import type { ResolveInput } from "../../language-adapter.ts";
import { resolveBySymbols } from "../../symbol-model.ts";
import { externalModuleOf, importPathToDirectory, isStandardLibrary, moduleOwning, modulesOf, type GoModule } from "./go-mod.ts";
import { isExported } from "./shape.ts";

/**
 * Go dependency resolution (suite.md, Language notes). An import path is resolved against the module paths
 * of the repository's go.mod files (and local `replace` directives) to the directory of a package. Files in
 * one directory and one package share their names without importing each other, so what is left is
 * symbol-based: each reference is resolved to the package that declares the name, and the shared symbol
 * model turns that into file edges and consumers.
 *
 * A package is a directory and a package name, so an external test package (`foo_test`) beside `foo` is
 * its own package that imports it. A name is looked for in the file's own package, then in packages it
 * dot-imports; `alias.Name` is looked for among the exported names of the imported package; and `Type.method`,
 * a method reached through its own receiver, in the file's own package.
 *
 * Imports of packages outside the repository are reported as external imports, named by the module go.mod
 * requires. The standard library is not. An import inside a module of the repository whose directory holds
 * no Go file is unresolved.
 */

const SEPARATOR = "\u0000";

export interface GoPackage {
  dir: string;
  name: string;
  files: string[];
}

/** What a file's imports reach, by the name each is written under. */
export interface FileImports {
  /** Local name to the key of the package it names. */
  locals: ReadonlyMap<string, string>;
  /** Packages imported with a dot, whose exported names are in scope unqualified. */
  dotted: readonly string[];
  unresolved: Unresolved[];
  externals: ExternalImport[];
}

/** The packages of a set of Go files, and how names in each file reach them. */
export class PackageGraph {
  readonly modules: readonly GoModule[];
  readonly packages = new Map<string, GoPackage>();
  /** Declarations by package key and name, with the files that declare each (build variants declare one name in several). */
  readonly declared = new Map<string, string[]>();
  private readonly facts: ReadonlyMap<string, FileFacts>;

  constructor(facts: ReadonlyMap<string, FileFacts>, configs: ReadonlyMap<string, string>) {
    this.facts = facts;
    this.modules = modulesOf(configs);
    for (const [file, facts] of this.facts) {
      const key = this.keyOfFile(file);
      const dir = posix.dirname(file);
      const existing = this.packages.get(key) ?? { dir, name: facts.symbols?.namespaces[0] ?? "", files: [] };
      existing.files.push(file);
      this.packages.set(key, existing);
      for (const declaration of facts.symbols?.declarations ?? []) {
        const declaredKey = `${key}${SEPARATOR}${declaration.name}`;
        this.declared.set(declaredKey, [...(this.declared.get(declaredKey) ?? []), file]);
      }
    }
  }

  static keyOf(dir: string, name: string): string {
    return `${dir}${SEPARATOR}${name}`;
  }

  keyOfFile(file: string): string {
    return PackageGraph.keyOf(posix.dirname(file), this.facts.get(file)?.symbols?.namespaces[0] ?? "");
  }

  /** The package an import of a directory reaches: the one that is not an external test package, with the most files. */
  importable(dir: string): GoPackage | undefined {
    return [...this.packages.values()]
      .filter((candidate) => candidate.dir === dir && !candidate.name.endsWith("_test"))
      .sort((a, b) => b.files.length - a.files.length || (a.name < b.name ? -1 : 1))[0];
  }

  /** What each import of a file reaches. */
  importsOf(file: string): FileImports {
    const locals = new Map<string, string>();
    const dotted: string[] = [];
    const unresolved: Unresolved[] = [];
    const externals: ExternalImport[] = [];
    for (const imported of this.facts.get(file)?.imports ?? []) {
      const specifier = imported.specifier;
      if (specifier === null) continue;
      const target = importPathToDirectory(this.modules, specifier);
      if (target === undefined) {
        if (!isStandardLibrary(specifier)) externals.push({ from: file, packageName: externalModuleOf(moduleOwning(this.modules, file), specifier), typeOnly: false });
        continue;
      }
      const reached = this.importable(target.dir);
      if (reached === undefined) {
        unresolved.push({ from: file, line: imported.line, specifier, reason: "not-found" });
        continue;
      }
      const local = imported.bindings[0]?.local ?? "";
      if (local === "_") continue;
      const key = PackageGraph.keyOf(reached.dir, reached.name);
      if (local === ".") dotted.push(key);
      else locals.set(local === "" ? reached.name : local, key);
    }
    return { locals, dotted, unresolved, externals };
  }

  /**
   * The declaration a written name reaches from a file: the package key and the name in it, or undefined
   * when it is outside the repository (or unexported in another package).
   */
  lookup(file: string, written: string, imports: FileImports): { key: string; name: string } | undefined {
    const own = this.keyOfFile(file);
    const has = (key: string, name: string): boolean => this.declared.has(`${key}${SEPARATOR}${name}`);
    const dot = written.indexOf(".");
    if (dot >= 0) {
      const head = written.slice(0, dot);
      const tail = written.slice(dot + 1);
      const imported = imports.locals.get(head);
      if (imported !== undefined) return isExported(tail) && has(imported, tail) ? { key: imported, name: tail } : undefined;
      return has(own, written) ? { key: own, name: written } : undefined;
    }
    if (has(own, written)) return { key: own, name: written };
    if (!isExported(written)) return undefined;
    for (const key of imports.dotted) if (has(key, written)) return { key, name: written };
    return undefined;
  }

  /** The files that declare a name in a package. */
  declarers(key: string, name: string): readonly string[] {
    return this.declared.get(`${key}${SEPARATOR}${name}`) ?? [];
  }
}

export function resolvePackages(input: ResolveInput): ResolvedDependencies {
  const graph = new PackageGraph(input.facts, input.configs);
  const unresolved: Unresolved[] = [];
  const externals = new Map<string, ExternalImport>();

  const resolved = new Map<string, FileFacts>();
  for (const [file, facts] of input.facts) {
    const symbols = facts.symbols;
    if (symbols === undefined) continue;
    const own = graph.keyOfFile(file);
    const imports = graph.importsOf(file);
    unresolved.push(...imports.unresolved);
    for (const external of imports.externals) externals.set(`${file}${SEPARATOR}${external.packageName}`, external);

    const references: SymbolReference[] = [];
    for (const reference of symbols.references) {
      const found = graph.lookup(file, reference.name, imports);
      if (found !== undefined) references.push({ ...reference, name: `${found.key}${SEPARATOR}${found.name}` });
    }
    const test = input.isTestPath(file);
    const declarations: SymbolDeclaration[] = symbols.declarations.map((declaration) => ({ ...declaration, name: `${own}${SEPARATOR}${declaration.name}`, exported: declaration.exported && !test }));
    resolved.set(file, { ...facts, symbols: { namespaces: [], uses: [], declarations, references } });
  }

  const result = resolveBySymbols({ ...input, facts: resolved });
  const unmangle = (name: string): string => name.slice(name.indexOf(SEPARATOR) + 1);
  return {
    ...result,
    consumers: result.consumers.map((consumer) => ({ ...consumer, toExport: unmangle(consumer.toExport) })),
    exports: result.exports.map((exported) => ({ ...exported, name: unmangle(exported.name), defined: { ...exported.defined, name: unmangle(exported.defined.name) } })),
    externalImports: [...externals.values()],
    unresolved,
  };
}

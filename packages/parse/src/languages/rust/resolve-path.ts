import { posix } from "node:path";
import type { FileFacts } from "../../facts.ts";
import type { ModuleResolver, Resolution } from "../../language-adapter.ts";
import { isManifestPath, ModuleTree, moduleDirectory, readCrates, type Crate } from "./crates.ts";

/**
 * Specifiers, as the extractor writes them (extract-facts.ts), are one of three things:
 *
 * - A path, with `self` and `super` already counted from the file's own module, so a `use` inside an inline
 *   module names the same thing wherever it sits: `crate::a::b`, `self::inner::c`, `super::d`, `serde::de`.
 *   A `use` names an item last, and the specifier is the path up to it. A path starts at the crate root
 *   (`crate`), at the file's module (`self`), at its parents (`super`), or at a crate (`std`, a dependency,
 *   or the crate's own library).
 * - A module declaration, `mod name` or `mod inner::name`, with `@file.rs` after it for `#[path = "file.rs"]`.
 *   It names the file of the module, which must exist.
 * - A bare macro, `macro name`, for a `name!(..)` that no `use` binds. It names the file of the importing crate
 *   that defines `macro_rules! name`, else the library root of a crate the importer depends on by path that
 *   exports the macro or re-exports the name. Any other macro belongs to a crate outside the tree.
 *
 * A module name in a path that has no file of its own is looked up among the names the module before it
 * re-exports (`crate::tls::Name`, where the root has `pub use other::tls`), and the path goes on in the file it names.
 *
 * Macros are scoped by crate, not textually: a `macro_rules!` is visible in every file of its crate whatever the
 * order of definition and `#[macro_use]`, and a macro of a path dependency is visible bare whether or not the
 * crate is brought in with `#[macro_use] extern crate`.
 */

export const isConfigPath = isManifestPath;

const builtinCrates = new Set(["std", "core", "alloc", "proc_macro", "test"]);

interface MacroDefinition {
  file: string;
  /** `#[macro_export]`: the macro is a name of the crate root, for other crates too. */
  exported: boolean;
}

const noMacros: ReadonlyMap<string, MacroDefinition> = new Map();

export class PathResolver implements ModuleResolver {
  readonly tree: ModuleTree;
  /** A `use` of an inline module of the file itself is no dependency. */
  readonly dropsSelfDependencies = true;
  /** A module's own `use` declarations are visible to its child modules, so `use super::Name` finds a name the parent only imports. */
  readonly importsAreVisible = true;
  /** A `use` depends on the file that defines the item, whichever modules re-export it on the way. */
  readonly edgesReachDefinitions = true;
  readonly globsBindNames = true;
  private readonly facts: ReadonlyMap<string, FileFacts>;
  private reexported: ((file: string, name: string) => string | null | undefined) | undefined;
  /** `macro_rules!` definitions by the crate that holds them, then by name. The first file in path order defines a name. */
  private macros: Map<string, Map<string, MacroDefinition>> | undefined;
  private pathParents: Map<string, string> | undefined;

  constructor(paths: readonly string[], configs: ReadonlyMap<string, string>, facts: ReadonlyMap<string, FileFacts> = new Map()) {
    this.tree = new ModuleTree(paths, readCrates(paths, configs));
    this.facts = facts;
  }

  followReexports(moduleNamed: (file: string, name: string) => string | null | undefined): void {
    this.reexported = moduleNamed;
  }

  resolve(from: string, specifier: string): Resolution {
    if (specifier.startsWith("mod ")) return this.declaredModule(from, specifier.slice(4));
    if (specifier.startsWith("macro ")) return this.bareMacro(from, specifier.slice(6));
    return this.usedPath(from, specifier.split("::"));
  }

  exportedElsewhere(modulePath: string, name: string): { file: string; name: string } | undefined {
    const place = this.tree.placeOf(modulePath);
    if (place === undefined || place.root !== modulePath) return undefined;
    const bare = name.endsWith("!");
    const macro = bare ? name.slice(0, -1) : name;
    const definition = this.macrosOf(modulePath).get(macro);
    if (definition?.exported === true) return { file: definition.file, name: `${macro}!` };
    // A bare macro of a crate that only re-exports it is followed as the plain name the crate root exports.
    if (bare && this.facts.get(modulePath)?.exports.some((exported) => exported.exported === macro && exported.local !== undefined) === true) return { file: modulePath, name: macro };
    return undefined;
  }

  /** What scopes a macro: the crate of the file, or its root file when no manifest owns it. */
  private scopeOf(file: string): string | undefined {
    const place = this.tree.placeOf(file);
    return place === undefined ? undefined : (place.crate?.manifest ?? place.root);
  }

  private macrosOf(file: string): ReadonlyMap<string, MacroDefinition> {
    if (this.macros === undefined) {
      this.macros = new Map();
      for (const [path, facts] of this.facts) {
        for (const exported of facts.exports) {
          if (!exported.exported.endsWith("!")) continue;
          const scope = this.scopeOf(path);
          if (scope === undefined) continue;
          let names = this.macros.get(scope);
          if (names === undefined) this.macros.set(scope, (names = new Map()));
          const name = exported.exported.slice(0, -1);
          if (!names.has(name)) names.set(name, { file: path, exported: exported.internal !== true });
        }
      }
    }
    const scope = this.scopeOf(file);
    return (scope === undefined ? undefined : this.macros.get(scope)) ?? noMacros;
  }

  /** The file whose `#[path = ".."] mod name;` names the file, when one does and the declaration is not inside an inline module. */
  private declaringFile(file: string): string | undefined {
    if (this.pathParents === undefined) {
      this.pathParents = new Map();
      for (const [path, facts] of this.facts) {
        for (const imported of facts.imports) {
          const at = imported.specifier?.indexOf("@") ?? -1;
          if (imported.declares !== true || imported.specifier === null || at < 0 || imported.specifier.slice(4, at).includes("::")) continue;
          const target = posix.normalize(posix.join(posix.dirname(path), imported.specifier.slice(at + 1)));
          if (target !== path && !this.pathParents.has(target)) this.pathParents.set(target, path);
        }
      }
    }
    return this.pathParents.get(file);
  }

  private bareMacro(from: string, name: string): Resolution {
    const own = this.macrosOf(from).get(name);
    if (own !== undefined) return { kind: "file", path: own.file };
    const crate = this.tree.placeOf(from)?.crate;
    for (const [, dir] of [...(crate?.dependencies ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const root = this.tree.crates.find((candidate) => candidate.dir === dir && candidate.name !== null)?.libRoot;
      if (root !== undefined && this.exportedElsewhere(root, `${name}!`) !== undefined) return { kind: "file", path: root };
    }
    return { kind: "builtin" };
  }

  private declaredModule(from: string, declaration: string): Resolution {
    const at = declaration.indexOf("@");
    if (at >= 0) {
      const target = posix.normalize(posix.join(posix.dirname(from), declaration.slice(at + 1)));
      return this.tree.has(target) ? { kind: "file", path: target } : { kind: "not-found" };
    }
    const place = this.tree.placeOf(from);
    const names = declaration.split("::");
    const name = names.pop()!;
    let directory = moduleDirectory(from, place?.root ?? from);
    for (const inline of names) directory = posix.join(directory, inline);
    const file = this.tree.child(directory, name);
    return file === undefined ? { kind: "not-found" } : { kind: "file", path: file };
  }

  private usedPath(from: string, segments: readonly string[]): Resolution {
    const [first, ...rest] = segments as [string, ...string[]];
    const place = this.tree.placeOf(from);
    if (first === "crate" || first === "self" || first === "super") {
      if (place === undefined) return { kind: "not-found" };
      if (first === "crate") {
        // `extern crate name;` at a root makes the crate a name of the root: `crate::name::Item`.
        const named = rest[0] === undefined || this.tree.child(posix.dirname(place.root), rest[0]) !== undefined ? undefined : this.crateNamed(place.crate, rest[0]);
        if (named?.libRoot !== undefined && named.libRoot !== place.root) return this.fileOf(this.tree.walk({ file: named.libRoot, root: named.libRoot }, rest.slice(1), this.reexported));
        return this.fileOf(this.tree.walk({ file: place.root, root: place.root }, rest, this.reexported));
      }
      if (first === "self") return this.fileOf(this.tree.walk({ file: from, root: place.root }, rest, this.reexported));
      // The parent of a module declared with `#[path]` is the file that declares it, wherever the file sits.
      const declaring = this.declaringFile(from);
      if (declaring !== undefined) return this.usedPath(declaring, ["self", ...rest]);
      let up = 1;
      let remainder = rest;
      while (remainder[0] === "super") {
        up++;
        remainder = remainder.slice(1);
      }
      if (up > place.path.length) return { kind: "not-found" };
      const parent = this.tree.walk({ file: place.root, root: place.root }, place.path.slice(0, place.path.length - up));
      return this.fileOf(this.tree.walk({ file: parent.file, root: place.root }, remainder, this.reexported));
    }
    if (builtinCrates.has(first)) return { kind: "builtin" };
    const crate = this.crateNamed(place?.crate, first);
    if (crate === undefined) return { kind: "external", packageName: first };
    if (crate.libRoot === undefined) return { kind: "not-found" };
    return this.fileOf(this.tree.walk({ file: crate.libRoot, root: crate.libRoot }, rest, this.reexported));
  }

  /** The file a walk ended in. A walk that left the tree through a re-export names nothing in it. */
  private fileOf(walked: { file: string; outside?: true; via?: string }): Resolution {
    if (walked.outside === true) return { kind: "builtin" };
    return { kind: "file", path: walked.file, ...(walked.via === undefined ? {} : { via: walked.via }) };
  }

  /** The crate a name in a `use` path stands for: the importing crate's own library, one of its path dependencies, or a crate of the tree by that name. */
  private crateNamed(importer: Crate | undefined, name: string): Crate | undefined {
    if (importer?.libName === name) return importer;
    const dependency = importer?.dependencies.get(name);
    if (dependency !== undefined) return this.tree.crates.find((crate) => crate.dir === dependency && crate.name !== null);
    return undefined;
  }
}

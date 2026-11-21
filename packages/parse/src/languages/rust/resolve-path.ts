import { posix } from "node:path";
import type { ModuleResolver, Resolution } from "../../language-adapter.ts";
import { isManifestPath, ModuleTree, moduleDirectory, readCrates, type Crate } from "./crates.ts";

/**
 * Specifiers, as the extractor writes them (extract-facts.ts), are one of two things:
 *
 * - A path, with `self` and `super` already counted from the file's own module, so a `use` inside an inline
 *   module names the same thing wherever it sits: `crate::a::b`, `self::inner::c`, `super::d`, `serde::de`.
 *   A `use` names an item last, and the specifier is the path up to it. A path starts at the crate root
 *   (`crate`), at the file's module (`self`), at its parents (`super`), or at a crate (`std`, a dependency,
 *   or the crate's own library).
 * - A module declaration, `mod name` or `mod inner::name`, with `@file.rs` after it for `#[path = "file.rs"]`.
 *   It names the file of the module, which must exist.
 */

export const isConfigPath = isManifestPath;

const builtinCrates = new Set(["std", "core", "alloc", "proc_macro", "test"]);

export class PathResolver implements ModuleResolver {
  readonly tree: ModuleTree;
  /** A `use` of an inline module of the file itself is no dependency. */
  readonly dropsSelfDependencies = true;
  /** A module's own `use` declarations are visible to its child modules, so `use super::Name` finds a name the parent only imports. */
  readonly importsAreVisible = true;

  constructor(paths: readonly string[], configs: ReadonlyMap<string, string>) {
    this.tree = new ModuleTree(paths, readCrates(paths, configs));
  }

  resolve(from: string, specifier: string): Resolution {
    return specifier.startsWith("mod ") ? this.declaredModule(from, specifier.slice(4)) : this.usedPath(from, specifier.split("::"));
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
      if (first === "crate") return this.fileOf(this.tree.walk({ file: place.root, root: place.root }, rest));
      if (first === "self") return this.fileOf(this.tree.walk({ file: from, root: place.root }, rest));
      let up = 1;
      let remainder = rest;
      while (remainder[0] === "super") {
        up++;
        remainder = remainder.slice(1);
      }
      if (up > place.path.length) return { kind: "not-found" };
      const parent = this.tree.walk({ file: place.root, root: place.root }, place.path.slice(0, place.path.length - up));
      return this.fileOf(this.tree.walk({ file: parent.file, root: place.root }, remainder));
    }
    if (builtinCrates.has(first)) return { kind: "builtin" };
    const crate = this.crateNamed(place?.crate, first);
    if (crate === undefined) return { kind: "external", packageName: first };
    if (crate.libRoot === undefined) return { kind: "not-found" };
    return this.fileOf(this.tree.walk({ file: crate.libRoot, root: crate.libRoot }, rest));
  }

  private fileOf(walked: { file: string }): Resolution {
    return { kind: "file", path: walked.file };
  }

  /** The crate a name in a `use` path stands for: the importing crate's own library, one of its path dependencies, or a crate of the tree by that name. */
  private crateNamed(importer: Crate | undefined, name: string): Crate | undefined {
    if (importer?.libName === name) return importer;
    const dependency = importer?.dependencies.get(name);
    if (dependency !== undefined) return this.tree.crates.find((crate) => crate.dir === dependency && crate.name !== null);
    return undefined;
  }
}

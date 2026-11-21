import { posix } from "node:path";
import type { ModuleResolver, Resolution } from "../../language-adapter.ts";
import { standardLibrary } from "./standard-library.ts";

/**
 * Resolves Python import specifiers to files of the repository.
 *
 * - An absolute specifier (`pkg.sub.mod`) is looked up under each import root: the repository root, the
 *   directory above the top-level package of the importing file (a `src/` layout), the directory of a script
 *   that sits in no package, and the same for every other file of the tree. The importing file's own root is
 *   tried first, so two packages with a module of one name resolve each to their own.
 * - A relative specifier (`.mod`, `..pkg.mod`, `.`) is looked up from the importing file's directory, one
 *   level up per extra dot. `.` is the package's `__init__.py`.
 * - A module is `a/b.py` or `a/b/__init__.py`. Directories without `__init__.py` (implicit namespace
 *   packages) are walked through, but a namespace directory is not itself a file to depend on.
 * - What matches no file is the standard library, a dependency outside the repository (its first segment is
 *   the package name), or, when its first segment is a package of the repository, not found.
 */
export class PythonResolver implements ModuleResolver {
  private readonly files: ReadonlySet<string>;
  /** Every import root of the tree, sorted. */
  readonly roots: readonly string[];
  private readonly rootOfDirectory = new Map<string, string>();
  private readonly topLevelNames = new Set<string>();

  constructor(paths: readonly string[]) {
    this.files = new Set(paths.filter((path) => path.endsWith(".py")));
    const roots = new Set<string>(["."]);
    for (const file of this.files) roots.add(this.rootOf(posix.dirname(file)));
    this.roots = [...roots].sort();
    for (const file of this.files) {
      const root = this.rootOf(posix.dirname(file));
      for (const relative of new Set([file, root === "." ? file : file.slice(root.length + 1)])) {
        const first = relative.split("/")[0]!;
        this.topLevelNames.add(first.endsWith(".py") ? first.slice(0, -3) : first);
      }
    }
  }

  /** The import root of a directory: above the top-level package it is in, or itself when it is in none. */
  rootOf(directory: string): string {
    const known = this.rootOfDirectory.get(directory);
    if (known !== undefined) return known;
    let top = directory;
    while (top !== "." && this.files.has(`${top}/__init__.py`)) top = posix.dirname(top);
    const root = top === directory && !this.files.has(`${directory}/__init__.py`) ? directory : top;
    this.rootOfDirectory.set(directory, root);
    return root;
  }

  private moduleFile(base: string, parts: readonly string[]): string | undefined {
    const stem = posix.join(base, ...parts);
    if (this.files.has(posix.join(stem, "__init__.py"))) return posix.join(stem, "__init__.py");
    if (parts.length > 0 && this.files.has(`${stem}.py`)) return `${stem}.py`;
    return undefined;
  }

  resolve(from: string, specifier: string): Resolution {
    const dots = /^\.*/.exec(specifier)![0].length;
    const parts = specifier.slice(dots).split(".").filter((part) => part !== "");
    if (dots > 0) {
      let base = posix.dirname(from);
      for (let level = 1; level < dots && base !== "."; level++) base = posix.dirname(base);
      const found = this.moduleFile(base, parts);
      return found === undefined ? { kind: "not-found" } : { kind: "file", path: found };
    }
    const own = this.rootOf(posix.dirname(from));
    for (const root of [own, ...this.roots.filter((candidate) => candidate !== own)]) {
      const found = this.moduleFile(root, parts);
      if (found !== undefined) return { kind: "file", path: found };
    }
    const first = parts[0] ?? "";
    if (this.topLevelNames.has(first)) return { kind: "not-found" };
    if (standardLibrary.has(first)) return { kind: "builtin" };
    return { kind: "external", packageName: first };
  }

  /** The dotted name that reaches a file from an import root, or undefined when the file is not under it. `pkg/__init__.py` is `pkg`. */
  moduleName(file: string, root: string): string | undefined {
    const relative = root === "." ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined;
    if (relative === undefined || !relative.endsWith(".py")) return undefined;
    const parts = relative.slice(0, -3).split("/");
    if (parts.at(-1) === "__init__") parts.pop();
    return parts.length === 0 ? undefined : parts.join(".");
  }

  reexportsImplicitly(path: string): boolean {
    return posix.basename(path) === "__init__.py";
  }

  submodule(modulePath: string, name: string): string | undefined {
    if (posix.basename(modulePath) !== "__init__.py") return undefined;
    return this.moduleFile(posix.dirname(modulePath), [name]);
  }
}

/** Python resolution reads no configuration: roots come from the layout of the tree. */
export const isConfigPath = (): boolean => false;

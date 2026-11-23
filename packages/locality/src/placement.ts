import { posix } from "node:path";
import { isBoundaryManifest } from "@code-health/parse/languages";

/** One file the move relocates. Imports are rewritten separately, so these are the only file operations. */
export interface FileOperation {
  from: string;
  to: string;
  /** `unit` files are the unit itself, `test` files are tests that import only the unit and move with it. */
  role: "unit" | "test";
}

/** Why a move is not made. Each is a guard of the spec, and none can be overridden except `needs-reason`. */
export type RefusalCode =
  | "barrel"
  | "collision"
  | "dirty-working-tree"
  | "fixed-point"
  | "fixed-point-destination"
  | "invalid-destination"
  | "needs-reason"
  | "no-change"
  | "package-boundary"
  | "package-entry";

export interface Refusal {
  code: RefusalCode;
  detail: string;
}

/** A refusal of where files land, with the short label the analysis counts it under when no target is usable. */
export interface PlacementRefusal extends Refusal {
  label: string;
}

export function relativeTo(folder: string, base: string): string {
  if (folder === base) return "";
  return base === "" ? folder : folder.slice(base.length + 1);
}

/** The folders that hold a package manifest (go.mod, package.json, Cargo.toml and the like). */
export function manifestFolders(tree: Iterable<string>): Set<string> {
  return new Set([...tree].filter((path) => isBoundaryManifest(path)).map((path) => (posix.dirname(path) === "." ? "" : posix.dirname(path))));
}

/** The folder of the nearest boundary (a directory holding a manifest) at or above a file, or "" for the root. */
function packageRoot(path: string, boundaries: ReadonlySet<string>): string {
  let folder = posix.dirname(path);
  for (;;) {
    const dir = folder === "." ? "" : folder;
    if (boundaries.has(dir)) return dir;
    if (dir === "") return "";
    folder = posix.dirname(folder);
  }
}

/** The `internal/` directories a path sits under, outermost first. Go lets only code under an `internal/` directory's parent import it. */
function internalScopes(path: string): string[] {
  const folders = posix.dirname(path).split("/");
  return folders.flatMap((folder, index) => (folder === "internal" ? [folders.slice(0, index + 1).join("/")] : []));
}

/**
 * The file operations that move a unit's files, and the tests that move with it, from `base` to `destination`.
 * The unit's layout is kept: each file lands at the same place relative to the destination as it has now
 * relative to `base`, and a test that sits outside `base` goes to the destination itself, beside the unit it tests.
 */
export function relocate(files: readonly string[], tests: readonly string[], base: string, destination: string): FileOperation[] {
  const operations: FileOperation[] = [];
  for (const file of files) {
    const offset = relativeTo(posix.dirname(file) === "." ? "" : posix.dirname(file), base);
    operations.push({ from: file, to: posix.join(destination, offset, posix.basename(file)), role: "unit" });
  }
  for (const test of tests) {
    const folder = posix.dirname(test) === "." ? "" : posix.dirname(test);
    const inside = base === "" || folder === base || folder.startsWith(`${base}/`);
    const offset = inside ? relativeTo(folder, base) : "";
    operations.push({ from: test, to: posix.join(destination, offset, posix.basename(test)), role: "test" });
  }
  return operations.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/**
 * What the language placement rules refuse about where operations land: a file leaving its package, a Go file
 * crossing an `internal/` directory (which the compiler restricts to code under its parent), and a file landing
 * on one that stays. The dry-run move planner and the analysis's choice of target both read this.
 */
export function placementRefusals(operations: readonly FileOperation[], manifests: ReadonlySet<string>, tree: ReadonlySet<string>): PlacementRefusal[] {
  const refusals: PlacementRefusal[] = [];
  const leaving = new Set(operations.map((operation) => operation.from));
  const landing = new Set<string>();
  for (const operation of operations) {
    if (packageRoot(operation.from, manifests) !== packageRoot(operation.to, manifests)) {
      refusals.push({ code: "package-boundary", detail: `${operation.from} would leave its package for ${operation.to}`, label: "crosses a package boundary" });
    }
    if (operation.from.endsWith(".go") && internalScopes(operation.from).join("\0") !== internalScopes(operation.to).join("\0")) {
      refusals.push({
        code: "fixed-point",
        detail: `${operation.from} to ${operation.to} crosses an internal/ directory, which the Go compiler restricts to code under its parent`,
        label: "crosses internal/",
      });
    }
    if (landing.has(operation.to)) refusals.push({ code: "collision", detail: `${operation.to} is the destination of two files`, label: "name collision" });
    else if (tree.has(operation.to) && !leaving.has(operation.to)) refusals.push({ code: "collision", detail: `${operation.to} already exists`, label: "name collision" });
    landing.add(operation.to);
  }
  return refusals;
}

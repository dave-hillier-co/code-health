import { posix } from "node:path";
import { stronglyConnectedComponents } from "@code-health/graph/scc";
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
  | "does-not-compile"
  | "dirty-working-tree"
  | "fixed-point"
  | "fixed-point-destination"
  | "import-cycle"
  | "invalid-destination"
  | "needs-reason"
  | "no-change"
  | "package-boundary"
  | "package-entry"
  | "package-main"
  | "testdata"
  | "unexported-use";

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
 * What Go placement rules read, because a Go folder is a package: which Go file uses which, and which folders
 * declare `package main`. Built once from the analysed revision.
 */
export interface GoPackages {
  /** For each production Go file, the Go files it uses, other than itself. */
  uses: ReadonlyMap<string, readonly string[]>;
  /** Folders that hold a production file declaring `package main`. */
  mainFolders: ReadonlySet<string>;
  /** Production Go files that declare `package main`. */
  mainFiles: ReadonlySet<string>;
  /**
   * For each production Go file, the unexported names it declares that another Go file of the same folder uses. A `_test.go` file of the
   * folder is part of the package for this rule, so it counts as a user.
   */
  unexportedUses: ReadonlyMap<string, readonly { name: string; by: string }[]>;
  /** The package name each production Go file declares. */
  packageNames: ReadonlyMap<string, string>;
}

/** One use of a definition by a file, as the analysis records it. */
export interface GoUse {
  from: string;
  to: string;
  toExport: string;
  toSymbol?: string;
}

const MAIN_PACKAGE = /^package\s+main\b/m;
const PACKAGE_CLAUSE = /^package\s+([A-Za-z_][A-Za-z0-9_]*)/m;

export function goPackages(edges: Iterable<{ from: string; to: string }>, texts: ReadonlyMap<string, string>, consumers: Iterable<GoUse> = []): GoPackages {
  const uses = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from === edge.to || !edge.from.endsWith(".go") || !edge.to.endsWith(".go")) continue;
    const list = uses.get(edge.from);
    if (list === undefined) uses.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }
  const mainFiles = new Set([...texts].filter(([path, text]) => path.endsWith(".go") && MAIN_PACKAGE.test(text)).map(([path]) => path));
  const unexportedUses = new Map<string, { name: string; by: string }[]>();
  for (const use of consumers) {
    const name = use.toSymbol ?? use.toExport;
    if (use.from === use.to || !use.from.endsWith(".go") || !use.to.endsWith(".go") || posix.dirname(use.from) !== posix.dirname(use.to)) continue;
    if (!/^[a-z_]/.test(name.split(".").pop() ?? "")) continue;
    const list = unexportedUses.get(use.to) ?? [];
    if (!list.some((entry) => entry.name === name && entry.by === use.from)) list.push({ name, by: use.from });
    unexportedUses.set(use.to, list);
  }
  return { uses, mainFolders: new Set([...mainFiles].map((path) => posix.dirname(path))), mainFiles, unexportedUses, packageNames: new Map([...texts].flatMap(([path, text]): [string, string][] => (path.endsWith(".go") && PACKAGE_CLAUSE.test(text) ? [[path, PACKAGE_CLAUSE.exec(text)![1]!]] : []))) };
}

/** The Go package rules for a set of moves: a file never joins a `package main` folder or leaves one, and a move never makes a package import itself or two packages import each other. */
function goRefusals(operations: readonly FileOperation[], go: GoPackages): PlacementRefusal[] {
  const refusals: PlacementRefusal[] = [];
  const moved = new Map(operations.filter((operation) => operation.from.endsWith(".go") && operation.role === "unit").map((operation) => [operation.from, operation.to]));
  if (moved.size === 0) return refusals;
  const movedWithTests = new Map([...moved, ...operations.filter((operation) => operation.from.endsWith(".go") && operation.role === "test").map((operation): [string, string] => [operation.from, operation.to])]);
  const newPath = (path: string) => moved.get(path) ?? path;
  const newPathWithTests = (path: string) => movedWithTests.get(path) ?? path;
  for (const [from, to] of moved) {
    const source = posix.dirname(from);
    const destination = posix.dirname(to);
    if (source === destination) continue;
    const isMain = go.mainFiles.has(from);
    const toMain = go.mainFolders.has(destination);
    if (!isMain && toMain) {
      refusals.push({ code: "package-main", detail: `${from} is a library file and ${destination} is a package main folder, which no package can import`, label: "package main folder" });
    } else if (isMain && !toMain) {
      refusals.push({ code: "package-main", detail: `${from} declares package main, which no package can import once it is in ${destination}`, label: "package main folder" });
    }
    for (const used of go.uses.get(from) ?? []) {
      if (posix.dirname(newPath(used)) === destination && posix.dirname(used) !== source) {
        refusals.push({ code: "import-cycle", detail: `import cycle: ${from} imports ${posix.dirname(used)}, so in ${destination} it would import its own package`, label: "import cycle" });
        break;
      }
    }
  }
  // An unexported name is reached only from its own package, so its declaring file and the files that use it stay in one folder.
  unexported: for (const [declared, uses] of go.unexportedUses) {
    for (const { name, by } of uses) {
      if ((movedWithTests.has(declared) || movedWithTests.has(by)) && posix.dirname(newPathWithTests(declared)) !== posix.dirname(newPathWithTests(by))) {
        refusals.push({ code: "unexported-use", detail: `unexported symbol used in its package: ${name} used by ${by}`, label: "unexported symbol used in its package" });
        break unexported;
      }
    }
  }
  const folderGraph = (mapping: (path: string) => string) => {
    const graph = new Map<string, Set<string>>();
    for (const [from, targets] of go.uses) {
      const folder = posix.dirname(mapping(from));
      for (const target of targets) {
        const other = posix.dirname(mapping(target));
        if (other === folder) continue;
        if (!graph.has(folder)) graph.set(folder, new Set());
        graph.get(folder)!.add(other);
        if (!graph.has(other)) graph.set(other, new Set());
      }
    }
    return new Map([...graph].map(([folder, targets]): [string, string[]] => [folder, [...targets]]));
  };
  const cyclic = (graph: Map<string, string[]>) =>
    new Set(stronglyConnectedComponents(graph).filter((component) => component.length > 1).flat());
  const before = cyclic(folderGraph((path) => path));
  const after = folderGraph(newPath);
  const cycleAfter = stronglyConnectedComponents(after).filter((component) => component.length > 1);
  for (const component of cycleAfter) {
    const fresh = component.filter((folder) => !before.has(folder));
    const touched = component.some((folder) => [...moved].some(([from, to]) => posix.dirname(from) === folder || posix.dirname(to) === folder));
    if (fresh.length === 0 || !touched) continue;
    const members = [...component].sort();
    refusals.push({ code: "import-cycle", detail: `import cycle: ${members.join(" and ")} would import each other`, label: "import cycle" });
    break;
  }
  return refusals;
}

/**
 * What the language placement rules refuse about where operations land: a file leaving its package, a Go file
 * crossing an `internal/` directory (which the compiler restricts to code under its parent), and a file landing
 * on one that stays. The dry-run move planner and the analysis's choice of target both read this.
 */
export function placementRefusals(operations: readonly FileOperation[], manifests: ReadonlySet<string>, tree: ReadonlySet<string>, go?: GoPackages): PlacementRefusal[] {
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
    const dir = posix.dirname(operation.from);
    if (operation.from.endsWith("_test.go") && dir !== posix.dirname(operation.to)) {
      const testdata = [...tree].find((path) => path.startsWith(dir === "." ? "testdata/" : `${dir}/testdata/`));
      if (testdata !== undefined) {
        refusals.push({ code: "testdata", detail: `${operation.from} would leave ${dir}/testdata behind, and Go tests read ./testdata of their own package folder (${testdata})`, label: "tests read the testdata folder they would leave" });
      }
    }
    if (landing.has(operation.to)) refusals.push({ code: "collision", detail: `${operation.to} is the destination of two files`, label: "name collision" });
    else if (tree.has(operation.to) && !leaving.has(operation.to)) refusals.push({ code: "collision", detail: `${operation.to} already exists`, label: "name collision" });
    landing.add(operation.to);
  }
  if (go !== undefined) refusals.push(...goRefusals(operations, go));
  return refusals;
}

import { posix } from "node:path";
import type { ExternalImport, FileEdge, ImportEdge, ResolvedDependencies, Unresolved } from "../../analyse-tree.ts";
import type { FileFacts } from "../../facts.ts";
import type { ResolveInput } from "../../language-adapter.ts";
import { resolveBySymbols } from "../../symbol-model.ts";
import { isHeader, isSource, stemOf } from "./extensions.ts";
import { includePathsOf } from "./include-paths.ts";

/**
 * C++ dependencies. `#include` is import-like, so it is resolved here against the include paths of
 * `compile_commands.json` (see include-paths.ts) into file edges. Calls and type uses are symbol-based: the
 * shared symbol model resolves each name against the declarations of the tree, and a name then reaches a file
 * only when that file's declarations are visible through the headers the user includes, directly or not. The
 * preprocessor is not run, so an include inside a disabled `#if` branch still counts.
 *
 * A header and its source file form one unit. A source file `x.cpp` that includes a header `x.h` of the same
 * name (or sits beside one) is the header's implementation, and the graph says so with one edge from the header to
 * the source file and none the other way. The two are then one dominator subtree, so the unit moves together,
 * and the include that every pair has is not mistaken for a cycle. A function declared in a header and
 * defined in the source file is attributed to the header, where callers see it.
 */

/** Directories of the C and POSIX libraries, whose headers are the system's and never a package of the project. */
const systemDirectories = new Set(["sys", "bits", "linux", "net", "netinet", "arpa", "asm", "mach", "os", "machine", "x86_64-linux-gnu", "CoreFoundation", "Foundation"]);

/**
 * The file an include reaches and the directory it was found through. `specifier` is `<name>` for an angle
 * include and `name` for a quoted one, which looks beside the including file first. `via` is "" for the
 * repository root.
 */
export function locateInclude(from: string, specifier: string, dirs: readonly string[], files: ReadonlySet<string>): { path: string; via: string; relativeToIncluder: boolean } | undefined {
  const angle = specifier.startsWith("<");
  const name = angle ? specifier.slice(1, -1) : specifier;
  const own = posix.dirname(from) === "." ? "" : posix.dirname(from);
  const places = angle ? dirs : [own, ...dirs];
  for (const [index, dir] of places.entries()) {
    const candidate = posix.normalize(dir === "" ? name : `${dir}/${name}`);
    if (files.has(candidate)) return { path: candidate, via: dir, relativeToIncluder: !angle && index === 0 };
  }
  return undefined;
}

export const resolveInclude = (from: string, specifier: string, dirs: readonly string[], files: ReadonlySet<string>): string | undefined => locateInclude(from, specifier, dirs, files)?.path;

export function resolveCpp(input: ResolveInput): ResolvedDependencies {
  const files = new Set(input.paths);
  const includePaths = includePathsOf(input.paths, input.configs);

  const includes = new Map<string, string[]>();
  const unresolved: Unresolved[] = [];
  const externals: ExternalImport[] = [];
  for (const [path, facts] of input.facts) {
    const dirs = includePaths.dirsFor(path);
    const direct = new Set<string>();
    for (const imported of facts.imports) {
      if (imported.specifier === null) continue;
      const target = resolveInclude(path, imported.specifier, dirs, files);
      if (target !== undefined) {
        if (target !== path) direct.add(target);
      } else if (imported.specifier.startsWith("<")) {
        const name = imported.specifier.slice(1, -1);
        const head = name.split("/")[0]!;
        if (name.includes("/") && !systemDirectories.has(head)) externals.push({ from: path, packageName: head, typeOnly: false });
      } else {
        unresolved.push({ from: path, line: imported.line, specifier: imported.specifier, reason: "not-found" });
      }
    }
    includes.set(path, [...direct].sort());
  }

  // A header and the source file that implements it.
  const implementations = new Map<string, string[]>();
  const pairedWith = new Map<string, string>();
  const paired = (a: string, b: string): boolean => pairedWith.get(a) === b || pairedWith.get(b) === a;
  const headersByDirectoryAndStem = new Map<string, string[]>();
  for (const path of input.facts.keys()) {
    if (!isHeader(path)) continue;
    const key = `${posix.dirname(path)}\0${stemOf(path)}`;
    headersByDirectoryAndStem.set(key, [...(headersByDirectoryAndStem.get(key) ?? []), path]);
  }
  for (const path of input.facts.keys()) {
    if (!isSource(path)) continue;
    const stem = stemOf(path);
    const header =
      (includes.get(path) ?? []).find((target) => isHeader(target) && stemOf(target) === stem) ??
      (headersByDirectoryAndStem.get(`${posix.dirname(path)}\0${stem}`) ?? [])[0];
    if (header === undefined) continue;
    pairedWith.set(path, header);
    implementations.set(header, [...(implementations.get(header) ?? []), path]);
  }

  // What each file can see: itself, what it includes at any depth, and the sources that implement those headers.
  const visibleCache = new Map<string, ReadonlySet<string>>();
  const visibleFrom = (start: string): ReadonlySet<string> => {
    const known = visibleCache.get(start);
    if (known !== undefined) return known;
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const target of includes.get(next) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
      // An implementation is visible, but what it includes is its own business and not its header's users'.
      for (const target of implementations.get(next) ?? []) seen.add(target);
    }
    visibleCache.set(start, seen);
    return seen;
  };

  // A definition whose declaration is in a header the file sees is attributed to the header.
  const prototypes = new Map<string, string[]>();
  for (const [path, facts] of input.facts) {
    const defined = new Set(facts.units.map((unit) => unit.qualifiedName));
    for (const declaration of facts.symbols?.declarations ?? []) {
      if (declaration.kind === "function" && declaration.unit !== undefined && !defined.has(declaration.unit)) prototypes.set(declaration.name, [...(prototypes.get(declaration.name) ?? []), path]);
    }
  }
  const stripped = new Map<string, FileFacts>();
  for (const [path, facts] of input.facts) {
    const symbols = facts.symbols;
    if (symbols === undefined) {
      stripped.set(path, facts);
      continue;
    }
    const defined = new Set(facts.units.map((unit) => unit.qualifiedName));
    const seen = visibleFrom(path);
    const declarations = symbols.declarations.filter(
      (declaration) =>
        !(declaration.kind === "function" && declaration.unit !== undefined && defined.has(declaration.unit) && (prototypes.get(declaration.name) ?? []).some((header) => header !== path && seen.has(header))),
    );
    stripped.set(path, { ...facts, symbols: { ...symbols, declarations } });
  }

  const byName = resolveBySymbols({ ...input, facts: stripped });
  const fileEdges = new Map<string, FileEdge>();
  for (const edge of byName.fileEdges) {
    if (!visibleFrom(edge.from).has(edge.to) || paired(edge.from, edge.to)) continue;
    fileEdges.set(`${edge.from}\0${edge.to}`, edge);
  }
  const consumers = byName.consumers.filter((consumer) => fileEdges.has(`${consumer.from}\0${consumer.to}`));

  const importEdges = new Map<string, ImportEdge>();
  const addImport = (from: string, to: string): void => {
    importEdges.set(`${from}\0${to}`, { from, to, kind: "import", typeOnly: false });
  };
  for (const edge of fileEdges.values()) addImport(edge.from, edge.to);
  for (const [from, targets] of includes) {
    for (const to of targets) {
      if (paired(from, to)) continue;
      addImport(from, to);
      const key = `${from}\0${to}`;
      if (!fileEdges.has(key)) fileEdges.set(key, { from, to, kind: input.isTestPath(from) ? "test" : "reference", calls: 0, references: 0 });
    }
  }
  for (const [header, sources] of implementations) for (const source of sources) addImport(header, source);

  return {
    importEdges: [...importEdges.values()],
    consumers,
    fileEdges: [...fileEdges.values()],
    barrels: [],
    exports: byName.exports,
    externalImports: externals,
    unresolved,
  };
}

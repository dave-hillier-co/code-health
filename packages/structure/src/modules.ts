import { usageError } from "@code-health/cli-kit/errors";
import { readComponents, type Component } from "@code-health/cochange/components";
import type { Edge } from "@code-health/graph/feedback-arc-set";
import { groupGraph, type GroupedGraph } from "@code-health/graph/group";
import { compareIds, type Graph } from "@code-health/graph/graph";
import { edgeKey, folderOf, type Project } from "./project.ts";

/**
 * What a dependency is counted between: single files, their folders, their packages, or configured components.
 * `default` is the level each file's language is judged at for cycles: a Go package (its directory), a C# folder,
 * and a file for every other language.
 */
export type Level = "file" | "folder" | "package" | "component" | "default";

const isGoFile = (path: string): boolean => path.endsWith(".go");
const isCSharpFile = (path: string): boolean => path.endsWith(".cs");

/** Whether two files are in one Go package: the same directory. They reference each other without imports, so the edge between them is not an import. */
export const inOneGoPackage = (from: string, to: string): boolean => isGoFile(from) && isGoFile(to) && folderOf(from) === folderOf(to);

export function readLevel(flag: string, value: unknown, allowed: readonly Level[], fallback: Level): Level {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as Level;
  throw usageError(`--${flag} must be ${allowed.map((l) => `"${l}"`).join(", ")}, not "${String(value)}"`);
}

/**
 * The module a file belongs to at a level, or undefined when it belongs to none. Components
 * are the suite-wide `components` globs; a file in no component is left out of that view.
 */
export function moduleOfFile(level: Level, project: Project, componentsConfig: Record<string, unknown>): (path: string) => string | undefined {
  switch (level) {
    case "file":
      return (path) => path;
    case "default":
      return (path) => (isGoFile(path) || isCSharpFile(path) ? folderOf(path) : path);
    case "folder":
      return folderOf;
    case "package":
      return (path) => project.packageOf(path);
    case "component": {
      const components: Component[] = readComponents(componentsConfig);
      if (components.length === 0) throw usageError('--by component needs "components" to be configured in code-health.json');
      return (path) => components.find((c) => c.matches(path))?.name;
    }
  }
}

/** The finest level at which both names are modules: a file, then a folder, then a package. */
export function inferLevel(project: Project, from: string, to: string): Level {
  const files = new Set(project.files);
  if (files.has(from) && files.has(to)) return "file";
  const folders = new Set(project.files.map(folderOf));
  if (folders.has(from) && folders.has(to)) return "folder";
  const packages = new Set(project.files.map((f) => project.packageOf(f)));
  if (packages.has(from) && packages.has(to)) return "package";
  throw usageError(`cannot tell what "${from}" and "${to}" are: they are not both files, both folders or both packages of the analysed commit; name the level with --level`);
}

export interface ModuleGraph extends GroupedGraph {
  level: Level;
  moduleOf(path: string): string | undefined;
  /** Production files of each module, sorted. */
  filesOf: ReadonlyMap<string, readonly string[]>;
  /** The module of every production file that has one. */
  moduleByFile: ReadonlyMap<string, string>;
}

export function buildModuleGraph(level: Level, project: Project, componentsConfig: Record<string, unknown>): ModuleGraph {
  const moduleOf = moduleOfFile(level, project, componentsConfig);
  const filesOf = new Map<string, string[]>();
  const moduleByFile = new Map<string, string>();
  for (const path of project.files) {
    const id = moduleOf(path);
    if (id === undefined) continue;
    moduleByFile.set(path, id);
    if (!filesOf.has(id)) filesOf.set(id, []);
    filesOf.get(id)!.push(path);
  }
  return { level, moduleOf, filesOf, moduleByFile, ...groupGraph(project.graph, moduleOf) };
}

export interface SymbolUse {
  /** `path#name` of what is used, in the module being depended on. */
  symbol: string;
  /** Reference sites, calls included. */
  sites: number;
  kind: "call" | "reference";
  /** Files in the depending module that use it. */
  usedBy: string[];
}

export interface EdgeDetail {
  /** File to file import edges behind the module edge. */
  fileEdges: number;
  importStatements: number;
  /** Every import statement behind the edge is `import type`. */
  typeOnly: boolean;
  /** The symbols used across the boundary, most used first. */
  symbols: SymbolUse[];
}

/** The facts under one module edge: what crosses the boundary, from the file edges and the uses behind them. */
export function describeEdge(project: Project, graph: ModuleGraph, from: string, to: string): EdgeDetail {
  const members: readonly Edge[] = graph.members.get(edgeKey(from, to)) ?? [];
  const bySymbol = new Map<string, { sites: number; call: boolean; usedBy: Set<string> }>();
  let importStatements = 0;
  let typeOnly = true;
  for (const edge of members) {
    const statements = project.imports.get(edgeKey(edge.from, edge.to)) ?? [];
    importStatements += statements.length;
    if (statements.some((s) => !s.typeOnly)) typeOnly = false;
    for (const use of project.consumers.get(edgeKey(edge.from, edge.to)) ?? []) {
      const symbol = `${use.to}#${use.toSymbol ?? use.toExport}`;
      const entry = bySymbol.get(symbol) ?? { sites: 0, call: false, usedBy: new Set<string>() };
      entry.sites += use.count;
      entry.call ||= use.kind === "call";
      entry.usedBy.add(use.from);
      bySymbol.set(symbol, entry);
    }
  }
  const symbols = [...bySymbol]
    .map(([symbol, entry]): SymbolUse => ({
      symbol,
      sites: entry.sites,
      kind: entry.call ? "call" : "reference",
      usedBy: [...entry.usedBy].sort(compareIds),
    }))
    .sort((a, b) => b.sites - a.sites || compareIds(a.symbol, b.symbol));
  return { fileEdges: members.length, importStatements, typeOnly: members.length > 0 && typeOnly, symbols };
}

/**
 * The graph cycles are found in. At file level an edge between two files of one Go package is not an import
 * (files of a package reference each other freely, and Go forbids cycles only between packages), so it is left out.
 */
export function importGraph(module: ModuleGraph): Graph {
  if (module.level !== "file") return module.graph;
  return new Map([...module.graph].map(([from, targets]) => [from, targets.filter((to) => !inOneGoPackage(from, to))]));
}

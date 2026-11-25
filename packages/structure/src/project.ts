import { normalise, type Graph } from "@code-health/graph/graph";
import { compileGlobs } from "@code-health/history/glob";
import { analyseTree, compareUtf8, type ProjectAnalysis } from "@code-health/parse/analyse-tree";
import type { Consumer, ImportEdge } from "@code-health/parse/resolved-dependencies";
import { readComponents } from "@code-health/cochange/components";
import { hasAdapter, isTestPath } from "@code-health/parse/languages";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef, type SourceTree } from "@code-health/parse/source-tree";
import { recordRunNote } from "@code-health/cli-kit/run-notes";
import { readBuildConfigs } from "@code-health/parse/build-configs";
import { describeIncludeResolution } from "@code-health/parse/include-resolution";
import { discoverPackages, indexPackages, type DiscoveredPackage, type PackageIndex } from "./packaging/discovery.ts";

export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** The production TypeScript and JavaScript of one commit, and how its files depend on each other. */
export interface Project {
  headSha: string;
  /** Production source files the grammars cover, sorted. Tests and excluded paths are not in it. */
  files: readonly string[];
  /** File to the files it imports, over `files` only. Every file is a node. Type-only imports are edges. */
  graph: Graph;
  analysis: ProjectAnalysis;
  /** Import statements by `edgeKey(importer, imported)`. */
  imports: ReadonlyMap<string, readonly ImportEdge[]>;
  /** Uses of what a file defines, by `edgeKey(consumer, defining file)`, tests left out. */
  consumers: ReadonlyMap<string, readonly Consumer[]>;
  /** The packages discovered from manifests (or the configured components where there are none), sorted by id. */
  packages: readonly DiscoveredPackage[];
  /** Which package owns a file. Built once here, so every command and level agrees on what a package is. */
  packageIndex: PackageIndex;
  /** Id of the package that owns the file, as `structure packages` reports it, "." when no package does. */
  packageOf(path: string): string;
}

/** What loading a project reads from the settings. `StructureSettings` satisfies it. */
export interface ProjectOptions {
  /** The suite's `exclude` globs. */
  exclude: readonly string[];
  /** The suite's `components`, as written. They stand in as packages where no manifest is found. */
  components?: Record<string, unknown>;
  entryPoints?: readonly string[];
  /** Build files read from disk that the tree does not hold (see `readBuildConfigs`). */
  extraConfigs?: ReadonlyMap<string, string>;
  /** The suite's `includeRoots`, for C and C++. */
  includeRoots?: readonly string[];
  /** Percent of C and C++ includes that found no file above which a warning and a notice are given. Defaults to 20. */
  unresolvedIncludePercent?: number;
  packages?: { ignore: readonly string[]; extra: readonly string[] };
}

/** Folder of a file, "." for the repository root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/** Analyses the tree of a commit, so the answer never depends on the working directory's state. */
export async function loadProject(root: string, headSha: string, options: ProjectOptions): Promise<Project> {
  const tree = await treeFromRef(root, headSha);
  return projectFromTree(tree, headSha, { ...options, extraConfigs: readBuildConfigs(root, tree) }, await ParseCache.forRepository(root));
}

/** The same for a tree already read, which the conformance suites build from a fixture directory. */
export async function projectFromTree(tree: SourceTree, headSha: string, options: ProjectOptions, cache?: ParseCache): Promise<Project> {
  const excluded = compileGlobs(options.exclude);
  const analysed = await analyseTree(tree, { ...(cache === undefined ? {} : { cache }), ...(options.extraConfigs === undefined ? {} : { extraConfigs: options.extraConfigs }), includeRoots: options.includeRoots ?? [] });
  if (analysed.includeResolution !== undefined) {
    const report = describeIncludeResolution(analysed.includeResolution, options.unresolvedIncludePercent ?? 20, "structure");
    recordRunNote({ key: "includeResolution", value: report.section, ...(report.notice === undefined ? {} : { notice: report.notice }), ...(report.warning === undefined ? {} : { warning: report.warning }) });
  }
  // what an excluded file imports from outside the repository is not the repository's need
  const analysis: ProjectAnalysis = { ...analysed, externalImports: analysed.externalImports.filter((external) => !excluded(external.from)) };

  const generated = new Set(analysis.generatedFiles);
  const files = [...tree.files.keys()]
    .filter((path) => hasAdapter(path) && !isTestPath(path) && !excluded(path) && !generated.has(path))
    .sort(compareUtf8);
  const inProject = new Set(files);

  const imports = new Map<string, ImportEdge[]>();
  const adjacency = new Map<string, string[]>(files.map((path) => [path, []]));
  for (const edge of analysis.importEdges) {
    if (edge.pairing === true || edge.test === true || !inProject.has(edge.from) || !inProject.has(edge.to)) continue;
    const key = edgeKey(edge.from, edge.to);
    imports.set(key, [...(imports.get(key) ?? []), edge]);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const consumers = new Map<string, Consumer[]>();
  for (const consumer of analysis.consumers) {
    if (consumer.kind === "test" || !inProject.has(consumer.from) || !inProject.has(consumer.to)) continue;
    const key = edgeKey(consumer.from, consumer.to);
    consumers.set(key, [...(consumers.get(key) ?? []), consumer]);
  }

  const components = readComponents(options.components ?? {});
  const packages = await discoverPackages(tree, {
    ignore: options.packages?.ignore ?? [],
    extra: options.packages?.extra ?? [],
    components,
    exclude: options.exclude,
    entryPoints: options.entryPoints ?? [],
  });
  const packageIndex = indexPackages(packages, components);
  const packageOf = (path: string): string => packageIndex.owner(path) ?? ".";

  return { headSha, files, graph: normalise(adjacency), analysis, imports, consumers, packages, packageIndex, packageOf };
}

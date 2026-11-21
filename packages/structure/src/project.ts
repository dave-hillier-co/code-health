import { normalise, type Graph } from "@code-health/graph/graph";
import { compileGlobs } from "@code-health/history/glob";
import { analyseTree, compareUtf8, type Consumer, type ImportEdge, type ProjectAnalysis } from "@code-health/parse/analyse-tree";
import { discoverBoundaries, hasAdapter, isTestPath } from "@code-health/parse/languages";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef, type SourceTree } from "@code-health/parse/source-tree";

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
  /** Directory of the nearest package.json at or above the file, "." when there is none. */
  packageOf(path: string): string;
}

/** Folder of a file, "." for the repository root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/** Analyses the tree of a commit, so the answer never depends on the working directory's state. */
export async function loadProject(root: string, headSha: string, exclude: readonly string[]): Promise<Project> {
  const tree = await treeFromRef(root, headSha);
  return projectFromTree(tree, headSha, exclude, await ParseCache.forRepository(root));
}

/** The same for a tree already read, which the conformance suites build from a fixture directory. */
export async function projectFromTree(tree: SourceTree, headSha: string, exclude: readonly string[], cache?: ParseCache): Promise<Project> {
  const analysis = await analyseTree(tree, cache === undefined ? {} : { cache });
  const excluded = compileGlobs(exclude);

  const generated = new Set(analysis.generatedFiles);
  const files = [...tree.files.keys()]
    .filter((path) => hasAdapter(path) && !isTestPath(path) && !excluded(path) && !generated.has(path))
    .sort(compareUtf8);
  const inProject = new Set(files);

  const imports = new Map<string, ImportEdge[]>();
  const adjacency = new Map<string, string[]>(files.map((path) => [path, []]));
  for (const edge of analysis.importEdges) {
    if (!inProject.has(edge.from) || !inProject.has(edge.to)) continue;
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

  const packageRoots = new Set((await discoverBoundaries(tree)).map((boundary) => boundary.dir));
  const packageOf = (path: string): string => {
    for (let folder = folderOf(path); ; folder = folderOf(folder)) {
      if (packageRoots.has(folder)) return folder;
      if (folder === ".") return ".";
    }
  };

  return { headSha, files, graph: normalise(adjacency), analysis, imports, consumers, packageOf };
}

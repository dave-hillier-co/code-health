import { compareUtf8, type ProjectAnalysis } from "./analyse-tree.ts";
import { isTestPath } from "./languages.ts";

/** Plain adjacency over string node ids, with keys and neighbours in UTF-8 byte order. */
export type Adjacency = Map<string, string[]>;

export interface GraphOptions {
  /** Keep edges from test files. Defaults to false for consumer graphs. */
  includeTests?: boolean;
  /** Used by importGraph, whose edges carry no test flag. Defaults to the analyser's own test-path rule. */
  isTestPath?: (path: string) => boolean;
}

function toAdjacency(edges: Iterable<[string, string]>): Adjacency {
  const sets = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    let targets = sets.get(from);
    if (!targets) {
      targets = new Set();
      sets.set(from, targets);
    }
    targets.add(to);
  }
  return new Map(
    [...sets].sort(([a], [b]) => compareUtf8(a, b)).map(([from, targets]) => [from, [...targets].sort(compareUtf8)]),
  );
}

/**
 * File-to-file import and re-export statements, barrels included. This is the graph a bundler sees.
 * Edges from test files are left out unless `includeTests` is set, so the graph is the production one.
 */
export function importGraph(analysis: ProjectAnalysis, options: GraphOptions = {}): Adjacency {
  const isTest = options.isTestPath ?? isTestPath;
  return toAdjacency(
    analysis.importEdges
      .filter((edge) => options.includeTests || !isTest(edge.from))
      .map((edge): [string, string] => [edge.from, edge.to]),
  );
}

/** Consumer file to the file that defines what it uses, with barrels followed through. */
export function consumerGraph(analysis: ProjectAnalysis, options: GraphOptions = {}): Adjacency {
  return toAdjacency(
    analysis.fileEdges
      .filter((edge) => options.includeTests || edge.kind !== "test")
      .map((edge): [string, string] => [edge.from, edge.to]),
  );
}

/**
 * Symbol-level consumers. A node is a symbol id (`path#Qualified.name`) when
 * the use sits in, or the definition is, a unit, and a path otherwise.
 */
export function symbolGraph(analysis: ProjectAnalysis, options: GraphOptions = {}): Adjacency {
  return toAdjacency(
    analysis.consumers
      .filter((consumer) => options.includeTests || consumer.kind !== "test")
      .map((consumer): [string, string] => [
        consumer.fromUnit === undefined ? consumer.from : `${consumer.from}#${consumer.fromUnit}`,
        consumer.toSymbol === undefined ? consumer.to : `${consumer.to}#${consumer.toSymbol}`,
      ]),
  );
}

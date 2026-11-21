import { compileGlobs } from "@code-health/history/glob";
import { analyseTree, type ProjectAnalysis } from "@code-health/parse/analyse-tree";
import { discoverBoundaries, hasAdapter, isTestPath } from "@code-health/parse/languages";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef, type SourceTree } from "@code-health/parse/source-tree";
import type { LocalitySettings } from "./config.ts";

/** Everything read from the analysed revision: the parsed project and the text of its production files. */
export interface Project {
  analysis: ProjectAnalysis;
  /** Production source files (the ones with a grammar that are not tests), in path order. */
  production: string[];
  isTest: (path: string) => boolean;
  /** Text of every production file. */
  texts: ReadonlyMap<string, string>;
  /** Files that a non-private package publishes as its main, module, types, bin or exports. */
  packageEntries: ReadonlySet<string>;
}

/** The tree without the files the suite config excludes. */
function withoutExcluded(tree: SourceTree, exclude: readonly string[]): SourceTree {
  if (exclude.length === 0) return tree;
  const excluded = compileGlobs(exclude);
  const files = new Map([...tree.files].filter(([path]) => !excluded(path)));
  return {
    files,
    read: async (path) => (files.has(path) ? tree.read(path) : undefined),
    readMany: (paths) => tree.readMany(paths.filter((path) => files.has(path))),
  };
}

export function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/** Parses the revision (through the shared parse cache) and reads the production files. */
export async function loadProject(root: string, ref: string, settings: LocalitySettings): Promise<Project> {
  const tree = withoutExcluded(await treeFromRef(root, ref), settings.exclude);
  const analysis = await analyseTree(tree, { cache: await ParseCache.forRepository(root) });
  const generated = new Set(analysis.generatedFiles);
  const production = [...tree.files.keys()].filter((path) => hasAdapter(path) && !isTestPath(path) && !generated.has(path));
  const texts = await tree.readMany(production);
  const packageEntries = await readPackageEntries(tree);
  return { analysis, production, isTest: isTestPath, texts, packageEntries };
}

/** The source lines of a unit, as the structural layer delimits it. */
export function unitText(project: Project, unit: { path: string; startLine: number; endLine: number }): string {
  const text = project.texts.get(unit.path);
  if (text === undefined) return "";
  return text.split("\n").slice(unit.startLine - 1, unit.endLine).join("\n");
}

/** Files that a non-private boundary publishes as its entry points, whatever language's manifest says so. */
async function readPackageEntries(tree: SourceTree): Promise<Set<string>> {
  const entries = new Set<string>();
  for (const boundary of await discoverBoundaries(tree)) {
    if (boundary.private === true) continue;
    for (const file of boundary.entryFiles) entries.add(file);
  }
  return entries;
}

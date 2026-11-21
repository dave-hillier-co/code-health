import { posix } from "node:path";
import { compileGlobs } from "@code-health/history/glob";
import { analyseTree, isTestPath, type ProjectAnalysis } from "@code-health/parse/analyse-tree";
import { grammarIdForPath } from "@code-health/parse/grammars";
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
  const production = [...tree.files.keys()].filter((path) => grammarIdForPath(path) !== undefined && !isTestPath(path));
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

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringLeaves(item, out);
}

async function readPackageEntries(tree: SourceTree): Promise<Set<string>> {
  const manifests = [...tree.files.keys()].filter((path) => path === "package.json" || path.endsWith("/package.json"));
  const entries = new Set<string>();
  for (const [path, text] of await tree.readMany(manifests)) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (manifest.private === true) continue;
    const targets: string[] = [];
    for (const key of ["main", "module", "types", "typings", "bin", "exports"]) stringLeaves(manifest[key], targets);
    const directory = posix.dirname(path);
    for (const target of targets) {
      if (target.includes("*")) continue;
      const resolved = posix.normalize(directory === "." ? target : posix.join(directory, target));
      if (tree.files.has(resolved)) entries.add(resolved);
    }
  }
  return entries;
}

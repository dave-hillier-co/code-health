import { compileGlobs } from "@code-health/history/glob";
import { analyseTree, type ProjectAnalysis } from "@code-health/parse/analyse-tree";
import { discoverBoundaries, hasAdapter, isTestPath } from "@code-health/parse/languages";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef, type SourceTree } from "@code-health/parse/source-tree";
import { recordRunNote } from "@code-health/cli-kit/run-notes";
import { readBuildConfigs } from "@code-health/parse/build-configs";
import { describeIncludeResolution } from "@code-health/parse/include-resolution";
import { isManifestPath, ModuleTree, readCrates } from "@code-health/parse/languages/rust/crates";
import type { LocalitySettings } from "./config.ts";
import { goPackages, type GoPackages } from "./placement.ts";

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
  /** Every path of the revision, excluded files too: where a moved file may land, and the manifests that bound packages. */
  tree: ReadonlySet<string>;
  /** The text of every `Cargo.toml` of the revision, which says where each Rust crate's targets are. */
  cargoManifests: ReadonlyMap<string, string>;
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
  const fullTree = await treeFromRef(root, ref);
  const tree = withoutExcluded(fullTree, settings.exclude);
  const analysis = await analyseTree(tree, { cache: await ParseCache.forRepository(root), extraConfigs: readBuildConfigs(root, tree), includeRoots: settings.includeRoots });
  if (analysis.includeResolution !== undefined) {
    const report = describeIncludeResolution(analysis.includeResolution, settings.unresolvedIncludePercent, "locality");
    recordRunNote({ key: "includeResolution", value: report.section, ...(report.notice === undefined ? {} : { notice: report.notice }), ...(report.warning === undefined ? {} : { warning: report.warning }) });
  }
  const generated = new Set(analysis.generatedFiles);
  const production = [...tree.files.keys()].filter((path) => hasAdapter(path) && !isTestPath(path) && !generated.has(path));
  const texts = await tree.readMany(production);
  const packageEntries = await readPackageEntries(tree);
  const cargoManifests = await fullTree.readMany([...fullTree.files.keys()].filter(isManifestPath));
  return { analysis, production, isTest: isTestPath, texts, packageEntries, tree: new Set(fullTree.files.keys()), cargoManifests };
}

/** What the Go placement rules read from a project: which Go file uses which, and the `package main` folders. */
export function goPackagesOf(project: Project): GoPackages {
  const production = new Set(project.production);
  return goPackages(project.analysis.importEdges.filter((edge) => production.has(edge.from) && production.has(edge.to)), project.texts, project.analysis.consumers.filter((consumer) => production.has(consumer.to) && (production.has(consumer.from) || (consumer.from.endsWith(".go") && project.isTest(consumer.from)))));
}

const rustModules = new WeakMap<Project, ModuleTree>();

/** What the Rust placement rule reads from a project: each crate's targets, and the module tree their files make. */
export function rustModulesOf(project: Project): ModuleTree {
  let found = rustModules.get(project);
  if (found === undefined) {
    const paths = [...project.tree];
    found = new ModuleTree(paths, readCrates(paths, project.cargoManifests));
    rustModules.set(project, found);
  }
  return found;
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

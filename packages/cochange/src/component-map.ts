import { classifyFiles } from "@code-health/history/file-class";
import { compileGlobs } from "@code-health/history/glob";
import { listBlobs } from "@code-health/history/tree";
import { isCodePath } from "@code-health/parse/code-files";
import { TEST_FOLDER_NAMES, testClassifier } from "@code-health/parse/test-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { readComponents, type Component } from "./components.ts";
import { readSettings } from "./config.ts";

/**
 * Top-level folders that group other folders instead of being a component themselves: each child folder is a
 * component, and the grouping folder is its group. The test folder names are the ones the suite already uses to
 * recognise test code (`TEST_FOLDER_NAMES`), so `test` and `tests` group their children like `src` does.
 */
export const GROUPING_FOLDERS: readonly string[] = [
  "src",
  "lib",
  "libs",
  "packages",
  "apps",
  "internal",
  "pkg",
  "cmd",
  "tools",
  "modules",
  "components",
  "services",
  "plugins",
  "samples",
  "examples",
  ...TEST_FOLDER_NAMES,
];

/** The group of components that are top-level folders, and of the files in the repository root. */
export const TOP_LEVEL_GROUP = "top level";

/** The component of files directly in the repository root. */
export const ROOT_COMPONENT = "(root)";

/** A component of the map: what the config states or what the inference proposes. */
export interface ComponentDefinition {
  name: string;
  /** The independent tree the component belongs to, or null when none is stated. */
  group: string | null;
  globs: string[];
}

const isGrouping = (folder: string) => GROUPING_FOLDERS.includes(folder.toLowerCase());
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Infers a component map from the folders of the given paths. A top-level folder is a component, except a grouping
 * folder (`GROUPING_FOLDERS`), whose child folders are the components and which is their group. Files directly in a
 * grouping folder form a component named for that folder, and files directly in the root form `(root)`. Components
 * with no path in `paths` are not listed. When two components would share a name, each is named `group/name`.
 */
export function inferComponents(paths: readonly string[]): ComponentDefinition[] {
  const found = new Map<string, ComponentDefinition & { sets: Set<string> }>();
  const add = (key: string, name: string, group: string, glob: string) => {
    const entry = found.get(key) ?? { name, group, globs: [], sets: new Set<string>() };
    entry.sets.add(glob);
    found.set(key, entry);
  };
  for (const path of paths) {
    const segments = path.split("/");
    const first = segments[0]!;
    if (segments.length === 1) add("", ROOT_COMPONENT, TOP_LEVEL_GROUP, directFiles("", path));
    else if (!isGrouping(first)) add(first, first, TOP_LEVEL_GROUP, `${first}/**`);
    else if (segments.length === 2) add(first, first, first, directFiles(first, path));
    else add(`${first}/${segments[1]}`, segments[1]!, first, `${first}/${segments[1]}/**`);
  }
  const definitions = [...found.values()].map(({ name, group, sets }) => ({ name, group, globs: [...sets].sort(byBytes) }));
  const taken = new Map<string, number>();
  for (const d of definitions) taken.set(d.name, (taken.get(d.name) ?? 0) + 1);
  const named = definitions.map((d) => ((taken.get(d.name) ?? 0) > 1 && d.group !== null && d.group !== d.name ? { ...d, name: `${d.group}/${d.name}` } : d));
  return named.sort((a, b) => byBytes(a.group ?? "", b.group ?? "") || byBytes(a.name, b.name));
}

/**
 * A glob for a file directly in `folder` (the root when empty) and no file below it: a glob with a slash also covers
 * everything beneath a folder it matches, so the files are named by extension, or by name when they have none.
 */
function directFiles(folder: string, path: string): string {
  const name = path.slice(folder === "" ? 0 : folder.length + 1);
  const dot = name.lastIndexOf(".");
  const prefix = folder === "" ? "/" : `${folder}/`;
  return dot > 0 ? `${prefix}*${name.slice(dot)}` : `${prefix}${name}`;
}

/** The `components` block for code-health.json that reads back as the given definitions. */
export function componentsBlock(definitions: readonly ComponentDefinition[]): { components: Record<string, { paths: string[]; group: string }> } {
  return { components: Object.fromEntries(definitions.map((d) => [d.name, { paths: d.globs, group: d.group ?? "" }])) };
}

export type MapSource = "configured" | "inferred";

export interface ComponentMap {
  source: MapSource;
  /** The components in the order of their group, then name. */
  components: (ComponentDefinition & { files: number })[];
  /** The component of a path, or null for a path in none. */
  componentOf(path: string): string | null;
  /** The production code files the map is read over. */
  files: string[];
  /** Production code files in no component. */
  unassigned: number;
}

/** The production code files of the tree at HEAD: code, not tests, not excluded, not generated, not vendored. */
export async function productionFiles(context: CommandContext): Promise<string[]> {
  const { root } = context.repo;
  const settings = readSettings(context.config);
  const head = settings.ref;
  const excluded = compileGlobs(settings.exclude);
  const isTest = testClassifier(context.config.effective.testPatterns);
  const languages = context.config.effective.languages;
  const blobs = (await listBlobs(root, head)).filter(({ path }) => !excluded(path) && isCodePath(path, languages) && !isTest(path));
  const tree = blobs.map((b) => b.path);
  const classes = await classifyFiles(root, head, blobs, tree);
  return tree.filter((path) => !classes.generated.has(path) && !classes.vendored.has(path));
}

function mapOf(source: MapSource, definitions: readonly ComponentDefinition[], components: readonly Component[], files: string[]): ComponentMap {
  const owner = (path: string) => components.find((c) => c.matches(path))?.name ?? null;
  const counts = new Map<string, number>();
  let unassigned = 0;
  for (const path of files) {
    const name = owner(path);
    if (name === null) unassigned++;
    else counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    source,
    components: definitions.map((d) => ({ ...d, files: counts.get(d.name) ?? 0 })),
    componentOf: owner,
    files,
    unassigned,
  };
}

/** The configured definitions, in the order of their group (components with no group last), then name. */
export function configuredDefinitions(components: readonly Component[]): ComponentDefinition[] {
  return components
    .map((c) => ({ name: c.name, group: c.group, globs: c.globs }))
    .sort((a, b) => Number(a.group === null) - Number(b.group === null) || byBytes(a.group ?? "", b.group ?? "") || byBytes(a.name, b.name));
}

/**
 * The component map of the run: the configured `components`, or the map inferred from the folders when none is
 * configured. `inferred: true` infers it even when one is configured, for `components --propose`.
 */
export async function resolveComponentMap(context: CommandContext, options: { inferred?: boolean } = {}): Promise<ComponentMap> {
  const files = await productionFiles(context);
  const configured = readComponents(context.config.effective.components);
  if (configured.length > 0 && options.inferred !== true) return mapOf("configured", configuredDefinitions(configured), configured, files);
  const definitions = inferComponents(files);
  const inferred = readComponents(Object.fromEntries(definitions.map((d) => [d.name, { paths: d.globs, group: d.group }])));
  return mapOf("inferred", definitions, inferred, files);
}

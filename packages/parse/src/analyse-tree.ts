import type { UnitShape } from "@code-health/lexical/unit";
import { parseWith } from "./file-facts.ts";
import type { FileFacts, UnitKind, UnitMetrics } from "./facts.ts";
import { cacheKeyOf, GrammarSet, type LoadOptions } from "./grammars.ts";
import { ImportModel } from "./import-model.ts";
import type { LanguageAdapter } from "./language-adapter.ts";
import type { ResolvedDependencies } from "./resolved-dependencies.ts";
import { isConfigPath, isTestPath as isTestPathOf, supportedAdapters } from "./languages.ts";
import type { ParseCache } from "./parse-cache.ts";
import type { SourceTree } from "./source-tree.ts";
import { resolveBySymbols } from "./symbol-model.ts";

/** A source unit as the structural layer reports it: the shared `UnitShape` (see the lexical package's unit.ts) with a path. */
export interface SourceUnit extends UnitShape {
  /** Repo-relative POSIX path. */
  path: string;
  /** Symbol id: `path#qualifiedName`. */
  id: string;
  /** Qualified name within the file, with `~n` on later duplicates. */
  qualifiedName: string;
  kind: UnitKind;
  /** Structural metrics. Functions only: classes have none. */
  metrics?: UnitMetrics;
  /** Declared with `export` or listed in an export clause at module level. */
  exported: boolean;
  /** The function calls itself directly. */
  recursive?: true;
  /** The method overrides or implements one its type inherits. */
  override?: true;
}

export interface ProjectAnalysis extends ResolvedDependencies {
  units: SourceUnit[];
  /** Files whose parse reported syntax errors, so their facts may be incomplete. */
  filesWithSyntaxErrors: string[];
  /** Files where a macro stands in for a declaration or a body of code, which a parser that does not run the preprocessor never sees. Languages with no preprocessor have none. */
  filesWithMacroCode: string[];
  /** Generated files, which are read as empty: they have no units and no edges, and are not production code. */
  generatedFiles: string[];
  stats: { parsed: number; cached: number };
}

export interface AnalyseOptions extends LoadOptions {
  cache?: ParseCache;
  /** Decides which files are tests. Defaults to the owning adapter's conventions (see `isTestPath` in languages.ts). */
  isTestPath?: (path: string) => boolean;
  /** The adapters to analyse with. Defaults to the supported ones. */
  adapters?: readonly LanguageAdapter[];
}

const batchSize = 200;

/** The dependency groups of a set of adapters: adapters sharing a `group` are resolved together by the first of them. */
function dependencyGroups(adapters: ReadonlySet<LanguageAdapter>): LanguageAdapter[][] {
  const groups = new Map<string, LanguageAdapter[]>();
  for (const adapter of [...adapters].sort((a, b) => compareUtf8(a.id, b.id))) {
    const key = adapter.dependencies.group ?? adapter.id;
    groups.set(key, [...(groups.get(key) ?? []), adapter]);
  }
  return [...groups.values()];
}

export async function analyseTree(tree: SourceTree, options: AnalyseOptions = {}): Promise<ProjectAnalysis> {
  const adapters = options.adapters ?? supportedAdapters();
  const isTest = options.isTestPath ?? ((path: string) => isTestPathOf(path, adapters));
  const grammars = new GrammarSet({ ...options, adapters });
  const loaded = new Map<string, FileFacts>();
  const owners = new Map<string, LanguageAdapter>();
  const stats = { parsed: 0, cached: 0 };
  const pending: string[] = [];

  for (const [path, blob] of tree.files) {
    const found = await grammars.forPath(path);
    if (!found) continue;
    owners.set(path, found.adapter);
    const cached = await options.cache?.get(blob, cacheKeyOf(found.adapter, found.grammar));
    if (cached) {
      loaded.set(path, cached);
      stats.cached++;
    } else {
      pending.push(path);
    }
  }

  for (let start = 0; start < pending.length; start += batchSize) {
    const sources = await tree.readMany(pending.slice(start, start + batchSize));
    for (const [path, source] of sources) {
      const { adapter, grammar } = (await grammars.forPath(path))!;
      const fileFacts = parseWith(adapter, grammar, source);
      loaded.set(path, fileFacts);
      stats.parsed++;
      await options.cache?.set(tree.files.get(path) as string, cacheKeyOf(adapter, grammar), fileFacts);
    }
  }

  // Sorted here, so output order never depends on the order the tree lists its files in.
  const sortedPaths = [...tree.files.keys()].sort(compareUtf8);
  const facts = new Map<string, FileFacts>();
  for (const path of sortedPaths) {
    const fileFacts = loaded.get(path);
    if (fileFacts) facts.set(path, fileFacts);
  }
  const configs = await tree.readMany(sortedPaths.filter((path) => isConfigPath(path, adapters)));

  const resolved: ResolvedDependencies[] = [];
  for (const group of dependencyGroups(new Set(owners.values()))) {
    const members = new Set(group.map((adapter) => adapter.id));
    const groupFacts = new Map([...facts].filter(([path]) => members.has(owners.get(path)!.id)));
    const input = { facts: groupFacts, paths: sortedPaths, configs, isTestPath: isTest };
    const dependencies = group[0]!.dependencies;
    resolved.push(
      dependencies.model === "import-based"
        ? new ImportModel(groupFacts, dependencies.createResolver(sortedPaths, configs), isTest).build()
        : (dependencies.resolve?.(input) ?? resolveBySymbols(input)),
    );
  }
  return { ...assemble(facts, resolved), stats };
}

/** The units, and the dependencies of every group merged and put in UTF-8 order. */
function assemble(facts: ReadonlyMap<string, FileFacts>, resolved: readonly ResolvedDependencies[]): Omit<ProjectAnalysis, "stats"> {
  const units: SourceUnit[] = [];
  const filesWithSyntaxErrors: string[] = [];
  const filesWithMacroCode: string[] = [];
  const generatedFiles: string[] = [];
  for (const [path, fileFacts] of facts) {
    if (fileFacts.generated === true) generatedFiles.push(path);
    if (fileFacts.hasSyntaxErrors) filesWithSyntaxErrors.push(path);
    if (fileFacts.macroGenerated !== undefined) filesWithMacroCode.push(path);
    const exportedLocals = new Set([
      ...fileFacts.exports.filter((exported) => exported.internal !== true).map((exported) => exported.local),
      ...(fileFacts.symbols?.declarations ?? []).filter((declaration) => declaration.exported).map((declaration) => declaration.unit),
    ]);
    for (const unit of fileFacts.units) {
      units.push({
        path,
        id: `${path}#${unit.qualifiedName}`,
        qualifiedName: unit.qualifiedName,
        kind: unit.kind,
        startLine: unit.startLine,
        endLine: unit.endLine,
        source: unit.source,
        ...(unit.parent === undefined ? {} : { parent: unit.parent }),
        ...(unit.metrics === undefined ? {} : { metrics: unit.metrics }),
        ...(unit.recursive === true ? { recursive: true as const } : {}),
        ...(unit.override === true ? { override: true as const } : {}),
        exported: unit.parent === undefined && exportedLocals.has(unit.qualifiedName),
      });
    }
  }
  const all = <K extends keyof ResolvedDependencies>(key: K): ResolvedDependencies[K][number][] => resolved.flatMap((group) => group[key] as ResolvedDependencies[K][number][]);
  return {
    units,
    importEdges: all("importEdges").sort(
      (a, b) =>
        compareUtf8(a.from, b.from) ||
        compareUtf8(a.to, b.to) ||
        compareUtf8(a.kind, b.kind) ||
        Number(a.typeOnly) - Number(b.typeOnly),
    ),
    consumers: all("consumers").sort(
      (a, b) =>
        compareUtf8(a.from, b.from) ||
        compareUtf8(a.fromUnit ?? "", b.fromUnit ?? "") ||
        compareUtf8(a.to, b.to) ||
        compareUtf8(a.toSymbol ?? a.toExport, b.toSymbol ?? b.toExport) ||
        compareUtf8(a.kind, b.kind),
    ),
    fileEdges: all("fileEdges").sort((a, b) => compareUtf8(a.from, b.from) || compareUtf8(a.to, b.to)),
    barrels: all("barrels").sort(compareUtf8),
    exports: all("exports").sort((a, b) => compareUtf8(a.file, b.file) || compareUtf8(a.name, b.name)),
    externalImports: all("externalImports").sort(
      (a, b) => compareUtf8(a.from, b.from) || compareUtf8(a.packageName, b.packageName) || Number(a.typeOnly) - Number(b.typeOnly),
    ),
    unresolved: all("unresolved").sort((a, b) => compareUtf8(a.from, b.from) || a.line - b.line || compareUtf8(a.specifier ?? "", b.specifier ?? "")),
    filesWithSyntaxErrors,
    filesWithMacroCode,
    generatedFiles,
  };
}

/** Compares strings by UTF-8 bytes, which is code point order. */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const delta = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (delta !== 0) return delta;
  }
}

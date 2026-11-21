import { compareIds } from "@code-health/graph/graph";
import { parseWith } from "@code-health/parse/file-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import { isManifestPath, readCrates } from "@code-health/parse/languages/rust/crates";
import { PathResolver } from "@code-health/parse/languages/rust/resolve-path";
import { parseToml, type TomlTable } from "@code-health/parse/toml";
import { edgeKey } from "../../project.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse.ts";

const crateName = (name: string): string => name.replaceAll("-", "_");

const table = (value: unknown): TomlTable => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TomlTable) : {});

/**
 * Reads the entry files of the cargo packages that have code. The marker is "anything not `pub` at the crate
 * root" (packaging.md, Languages), so a library's entries are its root file and the file of every module
 * reachable from it through `pub mod`. What a root re-exports with `pub use` is on its surface through the
 * exports of the root itself. A binary has no library surface: its entry is its own root.
 */
async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const paths = [...model.tree.files.keys()];
  const configs = await model.tree.readMany(paths.filter(isManifestPath));
  const crates = readCrates(paths, configs);
  const resolver = new PathResolver(paths, configs);
  const grammars = new GrammarSet();
  const entries = new Map<string, PackageEntries>();

  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "cargo" || pkg.manifest === null || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const crate = crates.find((candidate) => candidate.manifest === pkg.manifest);
    if (crate === undefined) continue;
    const files = new Set<string>();
    const pending = crate.libRoot === undefined ? [...crate.binRoots] : [crate.libRoot];
    while (pending.length > 0) {
      const file = pending.shift()!;
      if (files.has(file)) continue;
      files.add(file);
      if (crate.libRoot === undefined) continue;
      const source = await model.tree.read(file);
      const language = source === undefined ? undefined : await grammars.forPath(file);
      if (source === undefined || language === undefined) continue;
      const facts = parseWith(language.adapter, language.grammar, source);
      for (const exported of facts.exports) {
        if (exported.kind !== "namespace" || exported.internal === true || exported.local === undefined) continue;
        const declaration = facts.imports.find((imported) => imported.specifier?.startsWith("mod ") === true && imported.bindings.some((binding) => binding.local === exported.local));
        const found = declaration?.specifier == null ? undefined : resolver.resolve(file, declaration.specifier);
        if (found?.kind === "file") pending.push(found.path);
      }
    }
    entries.set(pkg.id, { id: pkg.id, files: new Set([...files].sort(compareIds)), wildcard: false, hasExportsMap: true });
  }
  return entries;
}

interface Declared {
  runtime: Set<string>;
  dev: Set<string>;
  optional: Set<string>;
  /** The crate name as written in `use` paths, to the package it names when it was renamed. */
  packageOf: Map<string, string>;
  /** The key as the manifest spells it, for messages. */
  written: Map<string, string>;
}

/** The dependency names a manifest declares, as `use` paths write them: by key, with a hyphen as an underscore. */
function declaredBy(text: string): Declared {
  const declared: Declared = { runtime: new Set(), dev: new Set(), optional: new Set(), packageOf: new Map(), written: new Map() };
  let toml: TomlTable;
  try {
    toml = parseToml(text);
  } catch {
    return declared;
  }
  for (const [section, scope] of [["dependencies", "runtime"], ["build-dependencies", "runtime"], ["dev-dependencies", "dev"]] as const) {
    for (const [key, value] of Object.entries(table(toml[section]))) {
      const name = crateName(key);
      declared[scope].add(name);
      declared.written.set(name, key);
      const spec = table(value);
      if (spec.optional === true) declared.optional.add(name);
      if (typeof spec.package === "string") declared.packageOf.set(name, crateName(spec.package));
    }
  }
  return declared;
}

/** Compares what each cargo package's manifest declares with what its code uses. */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const production = new Set(model.project.files);
  const externalsOf = new Map<string, { production: Set<string>; tests: Set<string> }>();
  for (const external of model.project.analysis.externalImports) {
    const owner = model.index.owner(external.from);
    if (owner === undefined) continue;
    const entry = externalsOf.get(owner) ?? { production: new Set<string>(), tests: new Set<string>() };
    (production.has(external.from) ? entry.production : entry.tests).add(crateName(external.packageName));
    externalsOf.set(owner, entry);
  }
  const cargoPackages = model.packages.filter((pkg) => pkg.ecosystem === "cargo");
  const packageNamed = (name: string) => cargoPackages.find((pkg) => crateName(pkg.name) === name);

  const findings: Finding[] = [];
  for (const pkg of cargoPackages) {
    if (!reuse.profiles.has(pkg.id) || pkg.manifest === null) continue;
    const declared = declaredBy((await model.tree.read(pkg.manifest)) ?? "");
    const named = (name: string): string => declared.packageOf.get(name) ?? name;
    const outside = externalsOf.get(pkg.id) ?? { production: new Set<string>(), tests: new Set<string>() };
    const own = crateName(pkg.name);

    const undeclared: { name: string; internal: boolean; via: "production" | "tests"; declaredAs: string | null }[] = [];
    for (const edge of model.edges.values()) {
      if (edge.from !== pkg.id) continue;
      const target = model.byId.get(edge.to)!;
      if (target.ecosystem !== "cargo") continue;
      const name = crateName(target.name);
      const key = [...declared.runtime, ...declared.dev].find((candidate) => named(candidate) === name);
      const scope = key === undefined ? null : declared.runtime.has(key) ? "runtime" : "dev";
      if (edge.productionImports > 0 && scope !== "runtime") undeclared.push({ name: target.name, internal: true, via: "production", declaredAs: scope });
      else if (edge.productionImports === 0 && edge.testImports > 0 && scope === null) undeclared.push({ name: target.name, internal: true, via: "tests", declaredAs: null });
    }
    for (const [names, via] of [[outside.production, "production"], [outside.tests, "tests"]] as const) {
      for (const name of [...names].sort(compareIds)) {
        if (name === own || packageNamed(name) !== undefined) continue;
        if (via === "tests" && outside.production.has(name)) continue;
        const inRuntime = declared.runtime.has(name);
        const inDev = declared.dev.has(name);
        if (via === "production" ? inRuntime : inRuntime || inDev) continue;
        undeclared.push({ name, internal: false, via, declaredAs: inDev ? "dev" : null });
      }
    }
    if (undeclared.length > 0) {
      const sorted = undeclared.sort((a, b) => compareIds(a.name, b.name));
      findings.push(
        raise(context, "undeclared-dependency", "boundary", [pkg.id],
          `${pkg.id} uses ${sorted.map((u) => u.name).join(", ")} without declaring ${sorted.length === 1 ? "it" : "them"}: the dependency graph the build sees is not the real one`,
          {
            dependencies: sorted.map((u) => u.name),
            internal: sorted.filter((u) => u.internal).map((u) => u.name),
            testsOnly: sorted.filter((u) => u.via === "tests").map((u) => u.name),
            declaredOnlyForDevelopment: sorted.filter((u) => u.declaredAs === "dev").map((u) => u.name),
            declaredAtRoot: [],
          }),
      );
    }

    const unused = [...declared.runtime]
      .filter((key) => !declared.optional.has(key))
      .filter((key) => {
        const internal = packageNamed(named(key));
        if (internal !== undefined) {
          const edge = model.edges.get(edgeKey(pkg.id, internal.id));
          return (edge?.productionImports ?? 0) + (edge?.testImports ?? 0) === 0;
        }
        return !outside.production.has(key) && !outside.tests.has(key);
      })
      .sort(compareIds);
    if (unused.length > 0) {
      findings.push(
        raise(context, "unused-dependency", "boundary", [pkg.id],
          `${pkg.id} declares ${unused.map((name) => declared.written.get(name) ?? name).join(", ")} and its code never uses ${unused.length === 1 ? "it" : "them"}: coupling with no purpose, and build weight`,
          { dependencies: unused.map((name) => declared.written.get(name) ?? name), internal: unused.filter((name) => packageNamed(named(name)) !== undefined) }),
      );
    }
  }
  return findings;
}

/** Cargo packages: crates, with entries read from `pub mod` and manifest checks against the crates their code names. */
export const language: PackagingLanguage = { id: "rust", readEntries, manifestChecks };

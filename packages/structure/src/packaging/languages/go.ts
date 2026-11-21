import { compareIds } from "@code-health/graph/graph";
import { parseGoMod, parseGoWork } from "@code-health/parse/languages/go/go-mod";
import { edgeKey } from "../../project.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../packaging-language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse-profile.ts";

/**
 * The internals marker of Go (packaging.md, Languages): what a module exposes is what another module can
 * import, which is every package outside an `internal/` directory, and within a package the exported
 * (capitalised) names. The entry files of a module are therefore its Go files outside `internal/`,
 * `testdata/` and `vendor/`, leaving out the files of `package main`, which nothing can import. Which names
 * of those files are exported is the adapter's, as the declarations it marks `exported`.
 */
const hidden = (relative: string): boolean => relative.split("/").some((part) => part === "internal" || part === "testdata" || part === "vendor");

async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const entries = new Map<string, PackageEntries>();
  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "go" || pkg.manifest === null || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const dir = pkg.dir ?? ".";
    const candidates = (model.files.get(pkg.id) ?? []).filter((path) => path.endsWith(".go") && !path.endsWith("_test.go") && !hidden(dir === "." ? path : path.slice(dir.length + 1)));
    const texts = await model.tree.readMany(candidates);
    const files = candidates.filter((path) => !/^package\s+main\b/m.test(texts.get(path) ?? "")).sort(compareIds);
    entries.set(pkg.id, { id: pkg.id, files: new Set(files), wildcard: false, hasExportsMap: true });
  }
  return entries;
}

/**
 * Compares what each module's go.mod requires with what its code imports. A require marked `// indirect` is
 * the toolchain's bookkeeping and is neither expected to be imported nor reported. A module of the
 * repository is declared when go.mod requires it or a go.work uses both modules.
 */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const workspaces: string[][] = [];
  for (const path of [...model.tree.files.keys()].filter((candidate) => candidate === "go.work" || candidate.endsWith("/go.work")).sort(compareIds)) {
    workspaces.push(parseGoWork(path, (await model.tree.read(path)) ?? ""));
  }
  const production = new Set(model.project.files);
  const externalsOf = new Map<string, { production: Set<string>; tests: Set<string> }>();
  for (const external of model.project.analysis.externalImports) {
    const owner = model.index.owner(external.from);
    if (owner === undefined) continue;
    const entry = externalsOf.get(owner) ?? { production: new Set<string>(), tests: new Set<string>() };
    (production.has(external.from) ? entry.production : entry.tests).add(external.packageName);
    externalsOf.set(owner, entry);
  }

  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    if (!reuse.profiles.has(pkg.id) || pkg.ecosystem !== "go" || pkg.manifest === null) continue;
    const manifest = parseGoMod(pkg.manifest, (await model.tree.read(pkg.manifest)) ?? "");
    const required = new Map(manifest.requires.map((entry) => [entry.path, entry]));
    const outside = externalsOf.get(pkg.id) ?? { production: new Set<string>(), tests: new Set<string>() };
    const inWorkspace = (other: string): boolean => workspaces.some((dirs) => dirs.includes(pkg.dir ?? ".") && dirs.includes(model.byId.get(other)?.dir ?? ""));

    const undeclared: { name: string; internal: boolean; via: "production" | "tests" }[] = [];
    for (const edge of model.edges.values()) {
      if (edge.from !== pkg.id) continue;
      const target = model.byId.get(edge.to)!;
      if (target.ecosystem !== "go" || required.has(target.name) || inWorkspace(edge.to)) continue;
      if (edge.productionImports > 0) undeclared.push({ name: target.name, internal: true, via: "production" });
      else if (edge.testImports > 0) undeclared.push({ name: target.name, internal: true, via: "tests" });
    }
    for (const [names, via] of [[outside.production, "production"], [outside.tests, "tests"]] as const) {
      for (const name of [...names].sort(compareIds)) {
        if (name === pkg.name || required.has(name) || model.packages.some((other) => other.name === name)) continue;
        if (via === "tests" && outside.production.has(name)) continue;
        undeclared.push({ name, internal: false, via });
      }
    }
    if (undeclared.length > 0) {
      const sorted = undeclared.sort((a, b) => compareIds(a.name, b.name));
      findings.push(
        raise(context, "undeclared-dependency", "boundary", [pkg.id],
          `${pkg.id} uses ${sorted.map((u) => u.name).join(", ")} without declaring ${sorted.length === 1 ? "it" : "them"}: the dependency graph the build sees is not the real one`,
          { dependencies: sorted.map((u) => u.name), internal: sorted.filter((u) => u.internal).map((u) => u.name), testsOnly: sorted.filter((u) => u.via === "tests").map((u) => u.name) }),
      );
    }

    const unused = manifest.requires
      .filter((entry) => !entry.indirect)
      .filter((entry) => {
        const internal = model.packages.find((other) => other.ecosystem === "go" && other.name === entry.path);
        if (internal !== undefined) {
          const edge = model.edges.get(edgeKey(pkg.id, internal.id));
          return (edge?.productionImports ?? 0) + (edge?.testImports ?? 0) === 0;
        }
        return !outside.production.has(entry.path) && !outside.tests.has(entry.path);
      })
      .map((entry) => entry.path)
      .sort(compareIds);
    if (unused.length > 0) {
      findings.push(
        raise(context, "unused-dependency", "boundary", [pkg.id],
          `${pkg.id} declares ${unused.join(", ")} and its code never uses ${unused.length === 1 ? "it" : "them"}: coupling with no purpose, and build weight`,
          { dependencies: unused, internal: unused.filter((name) => model.packages.some((other) => other.name === name)) }),
      );
    }
  }
  return findings;
}

/** Go packages: modules read from go.mod, with entries the Go files outside `internal/`. */
export const language: PackagingLanguage = { id: "go", readEntries, manifestChecks };

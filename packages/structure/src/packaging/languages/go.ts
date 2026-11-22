import { compareIds } from "@code-health/graph/graph";
import { parseGoMod, parseGoWork } from "@code-health/parse/languages/go/go-mod";
import type { DiscoveredPackage } from "../discovery.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../packaging-language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse-profile.ts";


/**
 * What a Go package exposes is its exported (capitalised) names, which the adapter marks `exported`, and the
 * compiler keeps `internal/` directories to their parent tree, so every file of a package is an entry file,
 * leaving out the files of `package main`, which nothing can import.
 */
async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const entries = new Map<string, PackageEntries>();
  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "go" || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const candidates = (model.files.get(pkg.id) ?? []).filter((path) => path.endsWith(".go") && !path.endsWith("_test.go"));
    const texts = await model.tree.readMany(candidates);
    const files = candidates.filter((path) => !/^package\s+main\b/m.test(texts.get(path) ?? "")).sort(compareIds);
    entries.set(pkg.id, { id: pkg.id, files: new Set(files), wildcard: false, hasExportsMap: true });
  }
  return entries;
}

const moduleDir = (manifest: string): string => (manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : ".");

interface Undeclared {
  internal: boolean;
  via: "production" | "tests";
  users: Set<string>;
}

/**
 * Compares what each module's go.mod requires with what the code of its packages imports. A require marked
 * `// indirect` is the toolchain's bookkeeping and is neither expected to be imported nor reported. A module of
 * the repository is declared when go.mod requires it or a go.work uses both modules. A finding is raised against
 * the packages of the module that import the dependency (undeclared), or against the module's first package
 * (unused), and its evidence names the module.
 */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const workspaces: string[][] = [];
  for (const path of [...model.tree.files.keys()].filter((candidate) => candidate === "go.work" || candidate.endsWith("/go.work")).sort(compareIds)) {
    workspaces.push(parseGoWork(path, (await model.tree.read(path)) ?? ""));
  }
  const production = new Set(model.project.files);

  const modules = new Map<string, DiscoveredPackage[]>();
  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "go" || pkg.manifest === null) continue;
    modules.set(pkg.manifest, [...(modules.get(pkg.manifest) ?? []), pkg]);
  }
  const packagesOfModule = (name: string): DiscoveredPackage[] => model.packages.filter((other) => other.ecosystem === "go" && other.module === name);

  const findings: Finding[] = [];
  for (const [manifestPath, members] of [...modules].sort(([a], [b]) => compareIds(a, b))) {
    if (!members.some((pkg) => reuse.profiles.has(pkg.id))) continue;
    const module = members[0]!.module ?? "";
    const memberIds = new Set(members.map((pkg) => pkg.id));
    const manifest = parseGoMod(manifestPath, (await model.tree.read(manifestPath)) ?? "");
    const required = new Map(manifest.requires.map((entry) => [entry.path, entry]));
    const inWorkspace = (other: DiscoveredPackage): boolean =>
      workspaces.some((dirs) => dirs.includes(moduleDir(manifestPath)) && dirs.includes(moduleDir(other.manifest ?? "")));

    const externals = { production: new Map<string, Set<string>>(), tests: new Map<string, Set<string>>() };
    for (const external of model.project.analysis.externalImports) {
      const owner = model.index.owner(external.from);
      if (owner === undefined || !memberIds.has(owner)) continue;
      const side = production.has(external.from) ? externals.production : externals.tests;
      side.set(external.packageName, (side.get(external.packageName) ?? new Set<string>()).add(owner));
    }

    const undeclared = new Map<string, Undeclared>();
    const note = (name: string, internal: boolean, via: "production" | "tests", user: string): void => {
      const known = undeclared.get(name) ?? { internal, via, users: new Set<string>() };
      if (via === "production") known.via = "production";
      known.users.add(user);
      undeclared.set(name, known);
    };
    for (const edge of model.edges.values()) {
      if (!memberIds.has(edge.from)) continue;
      const target = model.byId.get(edge.to)!;
      if (target.ecosystem !== "go" || target.module === module || required.has(target.module ?? "") || inWorkspace(target)) continue;
      if (edge.productionImports > 0) note(target.module ?? target.name, true, "production", edge.from);
      else if (edge.testImports > 0) note(target.module ?? target.name, true, "tests", edge.from);
    }
    for (const [side, via] of [[externals.production, "production"], [externals.tests, "tests"]] as const) {
      for (const name of [...side.keys()].sort(compareIds)) {
        if (name === module || required.has(name) || model.packages.some((other) => other.ecosystem !== "go" && other.name === name)) continue;
        if (via === "tests" && externals.production.has(name)) continue;
        for (const user of side.get(name)!) note(name, false, via, user);
      }
    }
    if (undeclared.size > 0) {
      const sorted = [...undeclared].sort(([a], [b]) => compareIds(a, b));
      const users = [...new Set(sorted.flatMap(([, entry]) => [...entry.users]))].sort(compareIds);
      findings.push(
        raise(context, "undeclared-dependency", "boundary", users,
          `${module} uses ${sorted.map(([name]) => name).join(", ")} without declaring ${sorted.length === 1 ? "it" : "them"}: the dependency graph the build sees is not the real one`,
          { module, dependencies: sorted.map(([name]) => name), internal: sorted.filter(([, e]) => e.internal).map(([name]) => name), testsOnly: sorted.filter(([, e]) => e.via === "tests").map(([name]) => name) },
          { subjects: [module] }),
      );
    }

    const importsModule = (name: string): boolean => {
      const ids = new Set(packagesOfModule(name).map((other) => other.id));
      return [...model.edges.values()].some((edge) => memberIds.has(edge.from) && ids.has(edge.to) && edge.productionImports + edge.testImports > 0);
    };
    const unused = manifest.requires
      .filter((entry) => !entry.indirect)
      .filter((entry) => (packagesOfModule(entry.path).length > 0 ? !importsModule(entry.path) : !externals.production.has(entry.path) && !externals.tests.has(entry.path)))
      .map((entry) => entry.path)
      .sort(compareIds);
    if (unused.length > 0) {
      findings.push(
        raise(context, "unused-dependency", "boundary", [members[0]!.id],
          `${module} declares ${unused.join(", ")} and its code never uses ${unused.length === 1 ? "it" : "them"}: coupling with no purpose, and build weight`,
          { module, dependencies: unused, internal: unused.filter((name) => packagesOfModule(name).length > 0) },
          { subjects: [module] }),
      );
    }
  }
  return findings;
}

/** Go packages grouped under their modules: every file of a package is an entry, and go.mod is checked per module. */
export const language: PackagingLanguage = { id: "go", checks: [{ ecosystem: "go", undeclared: true, unused: true }], readEntries, manifestChecks };

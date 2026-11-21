import { compareIds } from "@code-health/graph/graph";
import { parseCmake, publicHeaders } from "@code-health/parse/languages/cpp/cmake";
import { isHeader } from "@code-health/parse/languages/cpp/extensions";
import { edgeKey } from "../../project.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../packaging-language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse-profile.ts";

/**
 * The entry files of CMake targets that have C++ code. The internals marker of a C++ package is its public
 * include directory (packaging.md, Languages): the headers under a directory the library hands to its
 * consumers with `target_include_directories(... PUBLIC|INTERFACE ...)` are its entries, and every other header
 * is internal. A package whose CMakeLists.txt names no public include directory has not said what is public, so
 * every header it owns is an entry (a wildcard) and nothing in it can be reached too deeply.
 */
async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const paths = [...model.tree.files.keys()];
  const entries = new Map<string, PackageEntries>();
  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "cmake" || pkg.manifest === null || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const parsed = parseCmake((await model.tree.read(pkg.manifest)) ?? "");
    const { files, declared } = publicHeaders(pkg.dir === "." || pkg.dir === null ? "" : pkg.dir, parsed, paths, isHeader);
    const owned = (model.files.get(pkg.id) ?? []).filter(isHeader);
    entries.set(pkg.id, {
      id: pkg.id,
      files: new Set((declared ? files : owned).sort(compareIds)),
      wildcard: !declared,
      hasExportsMap: declared,
    });
  }
  return entries;
}

/**
 * Compares what each CMake target declares with `target_link_libraries` against what its code includes of
 * the other targets of the repository. Libraries from outside the repository are not seen by the structural
 * layer, so only dependencies between the repository's own targets are judged.
 */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    if (!reuse.profiles.has(pkg.id) || pkg.ecosystem !== "cmake") continue;
    const declared = new Set(pkg.dependencies.map((d) => d.name));
    const runtime = new Set(pkg.dependencies.filter((d) => d.scope === "runtime").map((d) => d.name));
    const names = (target: { name: string; aliases: readonly string[] }): string[] => [target.name, ...target.aliases];

    const undeclared: { name: string; via: "production" | "tests" }[] = [];
    for (const edge of model.edges.values()) {
      if (edge.from !== pkg.id) continue;
      const target = model.byId.get(edge.to)!;
      if (target.ecosystem !== "cmake") continue;
      if (edge.productionImports > 0 && !names(target).some((name) => runtime.has(name))) undeclared.push({ name: target.name, via: "production" });
      else if (edge.productionImports === 0 && edge.testImports > 0 && !names(target).some((name) => declared.has(name))) undeclared.push({ name: target.name, via: "tests" });
    }
    if (undeclared.length > 0) {
      const sorted = undeclared.sort((a, b) => compareIds(a.name, b.name));
      findings.push(
        raise(context, "undeclared-dependency", "boundary", [pkg.id],
          `${pkg.id} uses ${sorted.map((u) => u.name).join(", ")} without declaring ${sorted.length === 1 ? "it" : "them"}: the dependency graph the build sees is not the real one`,
          {
            dependencies: sorted.map((u) => u.name),
            internal: sorted.map((u) => u.name),
            testsOnly: sorted.filter((u) => u.via === "tests").map((u) => u.name),
            declaredOnlyForDevelopment: [],
            declaredAtRoot: [],
          }),
      );
    }

    const unused = pkg.dependencies
      .filter((d) => d.scope === "runtime" && !d.optional && d.target !== null)
      .filter((d) => {
        const edge = model.edges.get(edgeKey(pkg.id, d.target!));
        return (edge?.productionImports ?? 0) + (edge?.testImports ?? 0) === 0;
      })
      .map((d) => d.name)
      .sort(compareIds);
    if (unused.length > 0) {
      findings.push(
        raise(context, "unused-dependency", "boundary", [pkg.id],
          `${pkg.id} declares ${unused.join(", ")} and its code never uses ${unused.length === 1 ? "it" : "them"}: coupling with no purpose, and build weight`,
          { dependencies: unused, internal: unused },
        ),
      );
    }
  }
  return findings;
}

/** C++ packages: CMake targets, with the headers of the public include directory as entries. */
export const language: PackagingLanguage = { id: "cpp", readEntries, manifestChecks };

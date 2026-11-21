import { compareIds } from "@code-health/graph/graph";
import { edgeKey } from "../../project.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse.ts";

/**
 * The entry files of the .NET projects that have code. The internals marker of C# is `internal`: what a
 * project exposes is what its files declare as `public`, so its entry files are the files that export a type.
 * Everything else is internal, and a project reaching it does so through `InternalsVisibleTo`, which is a
 * deep import. There is no exports map to read, and every file is checked against the accessibility the
 * adapter extracted.
 */
async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const exporting = new Map<string, Set<string>>();
  for (const exported of model.project.analysis.exports) {
    const owner = model.index.owner(exported.file);
    if (owner === undefined) continue;
    exporting.set(owner, (exporting.get(owner) ?? new Set()).add(exported.file));
  }
  const entries = new Map<string, PackageEntries>();
  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "dotnet" || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    entries.set(pkg.id, { id: pkg.id, files: new Set([...(exporting.get(pkg.id) ?? [])].sort(compareIds)), wildcard: false, hasExportsMap: true });
  }
  return entries;
}

/**
 * Checks the project references each .NET project declares against what its code uses. There is no
 * undeclared-dependency check: a project can only use the types of the projects it references, directly or
 * through another, so a use of any other project does not resolve and never becomes a dependency. NuGet packages
 * are not checked either, because a package is not named by the namespaces that use it.
 */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    if (!reuse.profiles.has(pkg.id) || pkg.ecosystem !== "dotnet") continue;
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

/** .NET projects: entries are the files that declare a public type, and each project reference is checked against the types the project uses. */
export const language: PackagingLanguage = { id: "csharp", readEntries, manifestChecks };

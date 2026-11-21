import { compareIds } from "@code-health/graph/graph";
import { edgeKey } from "../../project.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse.ts";

/**
 * What Java and Kotlin share in packaging: Gradle and Maven modules are the packages, and what a module exposes
 * is what its code declares for other modules to use (the internals marker, packaging.md, Languages).
 *
 * - Java: a declaration that is not `public` is package-private, so it is not an entry. When the module has a
 *   descriptor (`module-info.java`), a package it does not `exports` (or only exports to named modules) is
 *   internal too, and so is every file in it.
 * - Kotlin: `private` and `internal` declarations are internal to their module.
 *
 * The structural layer marks a declaration `exported` only when it is public (or protected inside a public type),
 * so the entries of a module are its files that declare an exported name, less the files of non-exported
 * packages.
 */

const ecosystems = new Set(["gradle", "maven"]);
const isJvmSource = (path: string): boolean => path.endsWith(".java") || path.endsWith(".kt");

/** The packages a module descriptor exports to everyone, as written (`exports a.b;`), and false for a descriptor with none. */
export function exportedPackages(descriptor: string): Set<string> {
  const code = descriptor.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const exported = new Set<string>();
  for (const match of code.matchAll(/\bexports\s+([\w.]+)\s*(;|to\b)/g)) if (match[2] === ";") exported.add(match[1]!);
  return exported;
}

const packageOfSource = (text: string): string => /^\s*package\s+([\w.`]+)/m.exec(text)?.[1]?.replaceAll("`", "") ?? "";

/** The entry files of every Gradle or Maven module that has Java or Kotlin code, read from what its files declare and from its module descriptor. */
export async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const declaring = new Set(model.project.analysis.exports.map((exported) => exported.file));
  const entries = new Map<string, PackageEntries>();
  for (const pkg of model.packages) {
    if (!ecosystems.has(pkg.ecosystem) || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const owned = (model.files.get(pkg.id) ?? []).filter(isJvmSource);
    const descriptors = owned.filter((path) => path.endsWith("/module-info.java") || path === "module-info.java");
    const candidates = owned.filter((path) => declaring.has(path));
    let files = candidates;
    if (descriptors.length > 0) {
      const texts = await model.tree.readMany([...descriptors, ...candidates]);
      const exported = new Set(descriptors.flatMap((path) => [...exportedPackages(texts.get(path) ?? "")]));
      files = candidates.filter((path) => exported.has(packageOfSource(texts.get(path) ?? "")));
    }
    entries.set(pkg.id, { id: pkg.id, files: new Set([...files].sort(compareIds)), wildcard: false, hasExportsMap: descriptors.length > 0 });
  }
  return entries;
}

/**
 * Compares what each module's build file declares with the modules its code uses. Only modules of this
 * repository are judged: the symbol-based graph follows names inside the tree, so a library on the class path
 * is not seen.
 */
export async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    if (!reuse.profiles.has(pkg.id) || !ecosystems.has(pkg.ecosystem)) continue;
    const declared = new Map(pkg.dependencies.map((d) => [d.name, d]));
    const productionDeclared = new Set(pkg.dependencies.filter((d) => d.scope === "runtime").map((d) => d.name));

    const undeclared: { name: string; via: "production" | "tests" }[] = [];
    for (const edge of model.edges.values()) {
      if (edge.from !== pkg.id) continue;
      const target = model.byId.get(edge.to);
      if (target === undefined || !ecosystems.has(target.ecosystem)) continue;
      if (edge.productionImports > 0 && !productionDeclared.has(target.name)) undeclared.push({ name: target.name, via: "production" });
      else if (edge.productionImports === 0 && edge.testImports > 0 && !declared.has(target.name)) undeclared.push({ name: target.name, via: "tests" });
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
            declaredOnlyForDevelopment: sorted.filter((u) => declared.get(u.name)?.scope === "dev").map((u) => u.name),
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

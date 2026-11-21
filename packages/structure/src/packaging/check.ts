import { readComponents } from "@code-health/cochange/components";
import { runGit } from "@code-health/history/git";
import { treeFromRef } from "@code-health/parse/source-tree";
import type { FilteredHistory } from "@code-health/history/noise";
import type { StructureSettings } from "../config.ts";
import { loadProject } from "../project.ts";
import { resolveBase } from "../regressions.ts";
import { deepImports, manifestChecks } from "./boundaries.ts";
import { packageCycles } from "./coupling.ts";
import { discoverPackages } from "./discovery.ts";
import { findingContext } from "./findings.ts";
import { assemblePackageModel, type PackageModel } from "./model.ts";
import { analyseReuse } from "./reuse.ts";

/** A thing a change must not add: a package cycle, a deep import, or an undeclared dependency. */
export interface Violation {
  kind: "package-cycle" | "deep-import" | "undeclared-dependency";
  /** Identifies it across revisions, so one that was already there is not new. */
  key: string;
  packages: string[];
  detail: string;
}

/**
 * The violations at one commit. They need only the code and the manifests, so the model is built
 * with no history.
 */
export async function violationsAt(root: string, sha: string, settings: StructureSettings, model?: PackageModel): Promise<Violation[]> {
  const built = model ?? (await structuralModel(root, sha, settings));
  const context = findingContext(built);
  const reuse = await analyseReuse(built);
  const violations: Violation[] = [];
  for (const finding of packageCycles(context)) {
    violations.push({ kind: "package-cycle", key: `cycle:${[...finding.packages].sort().join(",")}`, packages: finding.packages, detail: finding.summary });
  }
  for (const finding of deepImports(context, reuse)) {
    for (const file of finding.evidence.files as string[]) {
      violations.push({ kind: "deep-import", key: `deep:${finding.packages[1]}->${file}`, packages: finding.packages, detail: `${finding.packages[1]} imports ${file}, past the entry points of ${finding.packages[0]}` });
    }
  }
  for (const finding of (await manifestChecks(context, reuse)).filter((f) => f.kind === "undeclared-dependency")) {
    for (const name of finding.evidence.dependencies as string[]) {
      violations.push({ kind: "undeclared-dependency", key: `undeclared:${finding.packages[0]}:${name}`, packages: finding.packages, detail: `${finding.packages[0]} uses ${name} without declaring it` });
    }
  }
  return violations.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function structuralModel(root: string, sha: string, settings: StructureSettings): Promise<PackageModel> {
  const tree = await treeFromRef(root, sha);
  const components = readComponents(settings.components);
  const packages = await discoverPackages(tree, { ignore: settings.packages.ignore, extra: settings.packages.extra, components, exclude: settings.exclude, entryPoints: settings.entryPoints });
  const date = Number((await runGit(root, ["log", "-1", "--format=%ct", sha])).trim());
  const nothing = { changes: [], imported: [] } as unknown as FilteredHistory;
  return assemblePackageModel(sha, { settings, filtered: nothing, window: { since: date, until: date } }, tree, packages, components, await loadProject(root, sha, settings.exclude));
}

/**
 * The revision to compare with: the one named, else `structure.base`, else the merge base of the analysed
 * commit with `structure.mainBranch` (or its `origin/` counterpart), as `structure check` does.
 */
export async function baseRevision(root: string, headSha: string, requested: string | undefined, settings: StructureSettings): Promise<string> {
  return (await resolveBase(root, headSha, settings, requested)).sha;
}

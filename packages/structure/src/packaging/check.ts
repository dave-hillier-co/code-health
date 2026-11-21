import { usageError } from "@code-health/cli-kit/errors";
import { readComponents } from "@code-health/cochange/components";
import { runGit } from "@code-health/history/git";
import { treeFromRef } from "@code-health/parse/source-tree";
import type { FilteredHistory } from "@code-health/history/noise";
import type { StructureSettings } from "../config.ts";
import { loadProject } from "../project.ts";
import { deepImports, manifestChecks } from "./boundaries.ts";
import { couplingFindings } from "./coupling.ts";
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
  for (const finding of couplingFindings(context).filter((f) => f.kind === "package-cycle")) {
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

async function structuralModel(root: string, sha: string, settings: StructureSettings): Promise<PackageModel> {
  const tree = await treeFromRef(root, sha);
  const components = readComponents(settings.components);
  const packages = await discoverPackages(tree, { ignore: settings.packages.ignore, extra: settings.packages.extra, components, exclude: settings.exclude });
  const date = Number((await runGit(root, ["log", "-1", "--format=%ct", sha])).trim());
  const nothing = { changes: [], imported: [] } as unknown as FilteredHistory;
  return assemblePackageModel(sha, { settings, filtered: nothing, window: { since: date, until: date } }, tree, packages, components, await loadProject(root, sha, settings.exclude));
}

/**
 * The revision to compare with: the one named, or the merge base of HEAD and the main branch. The main
 * branch is the configured `branch`, else the first of origin/main, origin/master, main and master that exists.
 */
export async function baseRevision(root: string, requested: string | undefined, settings: StructureSettings): Promise<string> {
  if (requested !== undefined) {
    try {
      return (await runGit(root, ["rev-parse", "--verify", `${requested}^{commit}`])).trim();
    } catch {
      throw usageError(`--base "${requested}" is not a revision of this repository`);
    }
  }
  const candidates = [settings.ref === "HEAD" ? undefined : settings.ref, "origin/main", "origin/master", "main", "master"].filter((c): c is string => c !== undefined);
  for (const candidate of candidates) {
    try {
      const head = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
      const other = (await runGit(root, ["rev-parse", "--verify", `${candidate}^{commit}`])).trim();
      if (other === head) continue;
      return (await runGit(root, ["merge-base", "HEAD", candidate])).trim();
    } catch {
      // not a branch here, or no common ancestor
    }
  }
  throw usageError("no base revision: pass --base <rev>, or configure structure.branch to the main branch");
}

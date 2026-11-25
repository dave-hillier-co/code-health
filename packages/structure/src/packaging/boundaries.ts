import { compareIds } from "@code-health/graph/graph";
import { compileGlobs } from "@code-health/history/glob";
import { isTestPath } from "@code-health/parse/languages";
import { edgeKey } from "../project.ts";
import { raise, type Finding, type FindingContext } from "./findings.ts";
import { packagingLanguages } from "./language.ts";
import { consumerPackages, purposeOf, type PackageModel } from "./model.ts";
import type { ReuseAnalysis } from "./reuse-profile.ts";

interface Imports {
  files: Set<string>;
  importers: Set<string>;
  tests: number;
}

/**
 * Consumers importing a package's internals, past its entry points. A package's own tests are not
 * consumers, and a package whose manifest exposes every file (a wildcard in `exports`) has no internals.
 */
export function deepImports(context: FindingContext, reuse: ReuseAnalysis): Finding[] {
  const { model } = context;
  const excluded = compileGlobs(model.settings.exclude);
  const found = new Map<string, Imports>();
  for (const edge of model.project.analysis.importEdges) {
    if (edge.pairing === true || excluded(edge.from) || excluded(edge.to) || isTestPath(edge.to)) continue;
    const consumer = model.index.owner(edge.from);
    const owner = model.index.owner(edge.to);
    if (consumer === undefined || owner === undefined || consumer === owner) continue;
    const entries = reuse.profiles.get(owner)?.entries;
    if (!entries || entries.files.has(edge.to)) continue;
    const key = edgeKey(consumer, owner);
    const entry = found.get(key) ?? { files: new Set<string>(), importers: new Set<string>(), tests: 0 };
    entry.files.add(edge.to);
    entry.importers.add(edge.from);
    if (edge.test === true || isTestPath(edge.from)) entry.tests++;
    found.set(key, entry);
  }
  return [...found]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([key, imports]) => {
      const [consumer, owner] = key.split("\u0000") as [string, string];
      const files = [...imports.files].sort(compareIds);
      return raise(context, "deep-import", "boundary", [owner, consumer],
        `${consumer} imports ${files.length} file${files.length === 1 ? "" : "s"} of ${owner} past its entry points: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}`,
        { files: files.slice(0, 10), fileCount: files.length, importers: imports.importers.size, fromTests: imports.tests, entries: [...(reuse.profiles.get(owner)?.entries.files ?? [])].slice(0, 5) },
        { subjects: [consumer, owner], changeCost: context.cost.pair(consumer, owner) });
    });
}

/**
 * Compares what each package's manifest declares with what its code uses, through the packaging language of
 * each package's ecosystem. A language whose packages declare no dependencies the structural layer sees
 * has no such check.
 */
export async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const language of packagingLanguages) findings.push(...(await language.manifestChecks(context, reuse)));
  return findings;
}

export interface NotSupported {
  ecosystem: string;
  check: "undeclared-dependency" | "unused-dependency";
  /** The packages of that ecosystem in the analysed commit, which this check did not look at. */
  packages: string[];
  notice: string;
}

/**
 * The dependency checks no packaging language makes for an ecosystem present in the repository, so that
 * the absence of a finding is not read as a clean result. Sorted by ecosystem, then check.
 */
export function unsupportedChecks(model: Pick<PackageModel, "packages">): NotSupported[] {
  const supported = new Map<string, { undeclared: boolean; unused: boolean }>();
  for (const language of packagingLanguages) {
    for (const check of language.checks) {
      const known = supported.get(check.ecosystem) ?? { undeclared: false, unused: false };
      supported.set(check.ecosystem, { undeclared: known.undeclared || check.undeclared, unused: known.unused || check.unused });
    }
  }
  const byEcosystem = new Map<string, string[]>();
  for (const pkg of model.packages) byEcosystem.set(pkg.ecosystem, [...(byEcosystem.get(pkg.ecosystem) ?? []), pkg.id]);
  const rows: NotSupported[] = [];
  for (const [ecosystem, packages] of [...byEcosystem].sort(([a], [b]) => compareIds(a, b))) {
    for (const check of ["undeclared-dependency", "unused-dependency"] as const) {
      const has = supported.get(ecosystem)?.[check === "undeclared-dependency" ? "undeclared" : "unused"] === true;
      if (has) continue;
      rows.push({
        ecosystem,
        check,
        packages: packages.sort(compareIds),
        notice: `${check} is not supported for the ${ecosystem} ecosystem: ${packages.length} package${packages.length === 1 ? "" : "s"} not checked, so the absence of a finding says nothing about them`,
      });
    }
  }
  return rows;
}

/** The evidence contradicts the reason a package was declared to exist. */
export function purposeMismatches(context: FindingContext, deep: readonly Finding[]): Finding[] {
  const { model } = context;
  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    const purpose = purposeOf(model, pkg);
    if (purpose === null) continue;
    const consumers = consumerPackages(model, pkg.id);
    if (purpose === "reuse" && consumers.length <= 1 && !pkg.entry) {
      findings.push(
        raise(context, "purpose-mismatch", "boundary", [pkg.id],
          consumers.length === 0 ? `${pkg.id} is declared for reuse and nothing uses it` : `${pkg.id} is declared for reuse and ${consumers[0]} is its only consumer`,
          { purpose, consumers: consumers.length },
          { subjects: [pkg.id, "reuse"] }),
      );
    }
    if (purpose === "enforcement") {
      const through = deep.filter((f) => f.packages[0] === pkg.id);
      if (through.length > 0) {
        findings.push(
          raise(context, "purpose-mismatch", "boundary", [pkg.id],
            `${pkg.id} exists to enforce a boundary and ${through.map((f) => f.packages[1]).join(", ")} import${through.length === 1 ? "s" : ""} its internals`,
            { purpose, deepImporters: through.map((f) => f.packages[1]!) },
            { subjects: [pkg.id, "enforcement"] }),
        );
      }
    }
  }
  return findings;
}

export async function boundaryFindings(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const deep = deepImports(context, reuse);
  return [...deep, ...(await manifestChecks(context, reuse)), ...purposeMismatches(context, deep)];
}

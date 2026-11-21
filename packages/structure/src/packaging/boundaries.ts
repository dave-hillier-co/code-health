import { compareIds } from "@code-health/graph/graph";
import { compileGlobs } from "@code-health/history/glob";
import { isTestPath } from "@code-health/parse/analyse-tree";
import { edgeKey } from "../project.ts";
import { raise, type Finding, type FindingContext } from "./findings.ts";
import { consumerPackages, purposeOf } from "./model.ts";
import type { ReuseAnalysis } from "./reuse.ts";

/** The name `@types/...` gives to the declarations of a package. */
const typesName = (name: string): string => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

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
    if (excluded(edge.from) || excluded(edge.to) || isTestPath(edge.to)) continue;
    const consumer = model.index.owner(edge.from);
    const owner = model.index.owner(edge.to);
    if (consumer === undefined || owner === undefined || consumer === owner) continue;
    const entries = reuse.profiles.get(owner)?.entries;
    if (!entries || entries.files.has(edge.to)) continue;
    const key = edgeKey(consumer, owner);
    const entry = found.get(key) ?? { files: new Set<string>(), importers: new Set<string>(), tests: 0 };
    entry.files.add(edge.to);
    entry.importers.add(edge.from);
    if (isTestPath(edge.from)) entry.tests++;
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
 * Compares what each package's manifest declares with what its code uses. Only npm packages are
 * read: the other ecosystems have no adapter that sees what their code imports.
 */
export async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const root = JSON.parse((await model.tree.read("package.json")) ?? "{}") as Record<string, Record<string, unknown> | undefined>;
  const declaredAtRoot = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
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
    if (!reuse.profiles.has(pkg.id) || pkg.ecosystem !== "npm") continue;
    const declared = new Map(pkg.dependencies.map((d) => [d.name, d]));
    const productionDeclared = new Set(pkg.dependencies.filter((d) => d.scope === "runtime").map((d) => d.name));
    const outside = externalsOf.get(pkg.id) ?? { production: new Set<string>(), tests: new Set<string>() };

    const undeclared: { name: string; internal: boolean; via: "production" | "tests"; declaredAs: string | null; atRoot: boolean }[] = [];
    for (const edge of model.edges.values()) {
      if (edge.from !== pkg.id) continue;
      const target = model.byId.get(edge.to)!;
      const entry = declared.get(target.name);
      if (edge.productionImports > 0 && !productionDeclared.has(target.name)) {
        undeclared.push({ name: target.name, internal: true, via: "production", declaredAs: entry?.scope ?? null, atRoot: false });
      } else if (edge.productionImports === 0 && edge.testImports > 0 && entry === undefined) {
        undeclared.push({ name: target.name, internal: true, via: "tests", declaredAs: null, atRoot: false });
      }
    }
    const usesOf = (name: string): boolean => outside.production.has(name) || outside.tests.has(name);
    for (const [names, via] of [[outside.production, "production"], [outside.tests, "tests"]] as const) {
      for (const name of [...names].sort(compareIds)) {
        if (name === pkg.name || model.packages.some((p) => p.name === name)) continue;
        if (via === "tests" && outside.production.has(name)) continue;
        const entry = declared.get(name) ?? declared.get(typesName(name));
        if (via === "production" ? entry !== undefined && entry.scope === "runtime" : entry !== undefined) continue;
        undeclared.push({ name, internal: false, via, declaredAs: entry?.scope ?? null, atRoot: declaredAtRoot.has(name) });
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
            declaredAtRoot: sorted.filter((u) => u.atRoot).map((u) => u.name),
          }),
      );
    }

    const unused = pkg.dependencies
      .filter((d) => d.scope === "runtime" && !d.optional && !d.name.startsWith("@types/"))
      .filter((d) => {
        if (d.target !== null) {
          const edge = model.edges.get(edgeKey(pkg.id, d.target));
          return (edge?.productionImports ?? 0) + (edge?.testImports ?? 0) === 0;
        }
        return !usesOf(d.name);
      })
      .map((d) => d.name)
      .sort(compareIds);
    if (unused.length > 0) {
      findings.push(
        raise(context, "unused-dependency", "boundary", [pkg.id],
          `${pkg.id} declares ${unused.join(", ")} and its code never uses ${unused.length === 1 ? "it" : "them"}: coupling with no purpose, and build weight`,
          { dependencies: unused, internal: unused.filter((name) => model.packages.some((p) => p.name === name)) }),
      );
    }
  }
  return findings;
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

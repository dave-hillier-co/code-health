import { compareIds } from "@code-health/graph/graph";
import { isConfigPath, SpecifierResolver } from "@code-health/parse/languages/typescript/resolve-specifier";
import { edgeKey } from "../../project.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../packaging-language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse-profile.ts";

/** The name `@types/...` gives to the declarations of a package. */
const typesName = (name: string): string => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Every string a (possibly conditional) export target can lead to. */
function targetsOf(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.flatMap(targetsOf);
  return Object.values(record(target)).flatMap(targetsOf);
}

const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** A regular expression for the files an export pattern such as `./src/*.ts` covers, whatever the emitted extension. */
function patternRegExp(dir: string, target: string): RegExp {
  // a build directory is not committed, so what it is built from is the same path under src, as the resolver also assumes
  const relative = target.replace(/^\.\//, "").replace(/^(?:dist|build|out|lib)\//, "src/");
  const stem = `${dir === "." ? "" : `${dir}/`}${relative}`.replace(/\.[cm]?[jt]sx?$/, "");
  return new RegExp(`^${stem.split("*").map(escape).join("(.*)")}\\.[cm]?[jt]sx?$`);
}

/**
 * Reads the entry files of the npm packages that have code. Resolution is the structural layer's own:
 * the same resolver that decides which file an import reaches, asked for each name a package exposes.
 */
async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const paths = [...model.tree.files.keys()];
  const configs = await model.tree.readMany(paths.filter(isConfigPath));
  const resolver = new SpecifierResolver(paths, configs);
  const entries = new Map<string, PackageEntries>();

  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "npm" || pkg.manifest === null || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const manifest = JSON.parse(configs.get(pkg.manifest) ?? "{}") as Record<string, unknown>;
    const owned = (model.files.get(pkg.id) ?? []).filter((path) => /\.[cm]?[jt]sx?$/.test(path));
    const dir = pkg.dir ?? ".";
    const files = new Set<string>();
    let wildcard = false;
    const hasExportsMap = manifest.exports !== undefined && manifest.exports !== null;

    const resolve = (subpath: string): void => {
      const found = resolver.resolve(`${dir === "." ? "" : `${dir}/`}x.ts`, `${pkg.name}${subpath === "." ? "" : subpath.slice(1)}`);
      if (found.kind === "file") files.add(found.path);
    };

    if (hasExportsMap) {
      const map = record(manifest.exports);
      const subpaths = Object.keys(map).some((key) => key.startsWith(".")) ? map : { ".": manifest.exports };
      for (const [key, target] of Object.entries(subpaths)) {
        if (!key.includes("*")) {
          resolve(key);
          continue;
        }
        wildcard = true;
        for (const text of targetsOf(target)) {
          const pattern = patternRegExp(dir, text);
          for (const path of owned) if (pattern.test(path)) files.add(path);
        }
      }
    } else {
      resolve(".");
    }
    entries.set(pkg.id, { id: pkg.id, files: new Set([...files].sort(compareIds)), wildcard, hasExportsMap });
  }
  return entries;
}

/**
 * Compares what each npm package's manifest declares with what its code imports.
 */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
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

/** TypeScript and JavaScript packages: npm manifests, with entries read through the adapter's own module resolver. */
export const language: PackagingLanguage = { id: "typescript", checks: [{ ecosystem: "npm", undeclared: true, unused: true }], readEntries, manifestChecks };

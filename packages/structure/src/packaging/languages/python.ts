import { compareIds } from "@code-health/graph/graph";
import { isTestPath } from "@code-health/parse/languages";
import { parseToml, type TomlTable, type TomlValue } from "@code-health/parse/toml";
import { edgeKey } from "../../project.ts";
import type { DeclaredDependency } from "../discovery.ts";
import type { PackageEntries } from "../entries.ts";
import { raise, type Finding, type FindingContext } from "../findings.ts";
import type { PackagingLanguage } from "../language.ts";
import type { PackageModel } from "../model.ts";
import type { ReuseAnalysis } from "../reuse.ts";

/** How a requirement is compared with an import: case, `-`, `_` and `.` do not matter. */
const normalise = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "_");

/** Distributions whose import name is not their name, which no rule of spelling derives. */
const importNames: Readonly<Record<string, readonly string[]>> = {
  pyyaml: ["yaml"],
  pillow: ["PIL"],
  scikit_learn: ["sklearn"],
  scikit_image: ["skimage"],
  beautifulsoup4: ["bs4"],
  opencv_python: ["cv2"],
  opencv_python_headless: ["cv2"],
  python_dateutil: ["dateutil"],
  attrs: ["attr", "attrs"],
  protobuf: ["google"],
  pyjwt: ["jwt"],
  python_dotenv: ["dotenv"],
  pycryptodome: ["Crypto"],
  psycopg2_binary: ["psycopg2"],
  msgpack_python: ["msgpack"],
  setuptools: ["setuptools", "pkg_resources"],
  pyserial: ["serial"],
  pymysql: ["pymysql", "MySQLdb"],
  mysqlclient: ["MySQLdb"],
  ruamel_yaml: ["ruamel"],
  typing_extensions: ["typing_extensions"],
};

/** True when a declared requirement may be the distribution that provides the import. */
function provides(requirement: string, importName: string): boolean {
  const name = normalise(requirement);
  const imported = normalise(importName);
  if (name === imported || name === `python_${imported}` || name === `${imported}_python` || name === `py${imported}` || name === `${imported}py`) return true;
  // namespace packages: `opentelemetry-api` provides `opentelemetry`, `types-requests` the stubs of `requests`
  if (name.startsWith(`${imported}_`) || name === `types_${imported}`) return true;
  return (importNames[name] ?? []).some((candidate) => normalise(candidate) === imported);
}

const record = (value: TomlValue | undefined): TomlTable => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {});

/** Names listed in a module's `__all__`, from every literal assignment to it (`=` and `+=`), or null when it has none. */
function allOf(text: string): Set<string> | null {
  const found = [...text.matchAll(/^__all__\s*(?::[^=\n]+)?\+?=\s*[[(]([^\])]*)[\])]/gm)];
  if (found.length === 0) return null;
  const names = new Set<string>();
  for (const match of found) for (const name of match[1]!.matchAll(/["']([A-Za-z_]\w*)["']/g)) names.add(name[1]!);
  return names;
}

const isDunder = (segment: string): boolean => segment.startsWith("__") && segment.endsWith("__");
const isPrivateSegment = (segment: string): boolean => segment.startsWith("_") && !isDunder(segment);

/**
 * Reads the entry files of the Python distributions that have code: every module a consumer may import,
 * which is every module of the distribution whose path has no leading-underscore segment, tests excluded. The
 * names an entry module exports are public unless they start with an underscore or, when the module has an
 * `__all__`, are left out of it. Without one, what a module imports is not offered, unless it is a package's `__init__`.
 */
async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
  const entries = new Map<string, PackageEntries>();
  const exportedBy = new Map<string, { name: string; reexport: boolean }[]>();
  for (const exported of model.project.analysis.exports) {
    exportedBy.set(exported.file, [...(exportedBy.get(exported.file) ?? []), { name: exported.name, reexport: exported.defined.file !== exported.file }]);
  }

  for (const pkg of model.packages) {
    if (pkg.ecosystem !== "python" || pkg.manifest === null || (model.codeFiles.get(pkg.id)?.length ?? 0) === 0) continue;
    const dir = pkg.dir ?? ".";
    const prefix = dir === "." ? "" : `${dir}/`;
    const owned = (model.files.get(pkg.id) ?? []).filter((path) => path.endsWith(".py") && !isTestPath(path));
    const files = new Set<string>();
    for (const path of owned) {
      const relative = path.slice(prefix.length).replace(/^src\//, "").replace(/\.py$/, "");
      if (!relative.split("/").some(isPrivateSegment)) files.add(path);
    }
    const texts = await model.tree.readMany([...files]);
    const hidden = new Set<string>();
    for (const file of files) {
      const all = allOf(texts.get(file) ?? "");
      const isPackageInit = file.endsWith("/__init__.py") || file === "__init__.py";
      for (const { name, reexport } of exportedBy.get(file) ?? []) {
        // Without an `__all__`, a name is public unless it starts with an underscore, and a module other than a package's
        // `__init__` passes along what it imports without meaning to offer it.
        const isHidden = all === null ? name.startsWith("_") || (reexport && !isPackageInit) : !all.has(name);
        if (isHidden) hidden.add(`${file}#${name}`);
      }
    }
    entries.set(pkg.id, { id: pkg.id, files: new Set([...files].sort(compareIds)), wildcard: false, hasExportsMap: true, hidden });
  }
  return entries;
}

/** Requirement names a manifest declares at runtime, for the root manifest's workspace-wide dependencies. */
async function declaredAtRoot(model: PackageModel): Promise<Set<string>> {
  const toml = parseToml((await model.tree.read("pyproject.toml")) ?? "");
  const project = record(toml.project);
  const names = new Set<string>();
  const add = (requirement: TomlValue): void => {
    if (typeof requirement === "string") names.add(normalise(/^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(requirement.trim())?.[0] ?? requirement));
  };
  if (Array.isArray(project.dependencies)) project.dependencies.forEach(add);
  for (const group of Object.values(record(project["optional-dependencies"]))) if (Array.isArray(group)) group.forEach(add);
  return names;
}

/**
 * Compares what each Python distribution's manifest declares with what its code imports. An import is matched
 * to a requirement by name, with the common distributions whose import name differs listed above, so an
 * undeclared dependency is a likely gap and not a proof.
 */
async function manifestChecks(context: FindingContext, reuse: ReuseAnalysis): Promise<Finding[]> {
  const { model } = context;
  const atRoot = await declaredAtRoot(model);
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
    if (!reuse.profiles.has(pkg.id) || pkg.ecosystem !== "python") continue;
    const outside = externalsOf.get(pkg.id) ?? { production: new Set<string>(), tests: new Set<string>() };
    const declaredRuntime = pkg.dependencies.filter((d) => d.scope === "runtime");
    const declares = (dependencies: readonly DeclaredDependency[], importName: string): DeclaredDependency | undefined => dependencies.find((d) => provides(d.name, importName));

    const undeclared: { name: string; internal: boolean; via: "production" | "tests"; declaredAs: string | null; atRoot: boolean }[] = [];
    for (const edge of model.edges.values()) {
      if (edge.from !== pkg.id) continue;
      const target = model.byId.get(edge.to)!;
      if (target.ecosystem !== "python") continue;
      const entry = pkg.dependencies.find((d) => normalise(d.name) === normalise(target.name));
      if (edge.productionImports > 0 && !declaredRuntime.some((d) => normalise(d.name) === normalise(target.name))) {
        undeclared.push({ name: target.name, internal: true, via: "production", declaredAs: entry?.scope ?? null, atRoot: false });
      } else if (edge.productionImports === 0 && edge.testImports > 0 && entry === undefined) {
        undeclared.push({ name: target.name, internal: true, via: "tests", declaredAs: null, atRoot: false });
      }
    }
    for (const [names, via] of [[outside.production, "production"], [outside.tests, "tests"]] as const) {
      for (const name of [...names].sort(compareIds)) {
        if (via === "tests" && outside.production.has(name)) continue;
        if (model.packages.some((p) => p.ecosystem === "python" && provides(p.name, name))) continue;
        const entry = declares(via === "production" ? declaredRuntime : pkg.dependencies, name);
        if (entry !== undefined) continue;
        undeclared.push({ name, internal: false, via, declaredAs: declares(pkg.dependencies, name)?.scope ?? null, atRoot: [...atRoot].some((requirement) => provides(requirement, name)) });
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

    const used = [...outside.production, ...outside.tests];
    const unused = pkg.dependencies
      .filter((d) => d.scope === "runtime" && !d.optional && !normalise(d.name).startsWith("types_"))
      .filter((d) => {
        if (d.target !== null) {
          const edge = model.edges.get(edgeKey(pkg.id, d.target));
          return (edge?.productionImports ?? 0) + (edge?.testImports ?? 0) === 0;
        }
        return !used.some((name) => provides(d.name, name));
      })
      .map((d) => d.name)
      .sort(compareIds);
    if (unused.length > 0) {
      findings.push(
        raise(context, "unused-dependency", "boundary", [pkg.id],
          `${pkg.id} declares ${unused.join(", ")} and its code never uses ${unused.length === 1 ? "it" : "them"}: coupling with no purpose, and build weight`,
          { dependencies: unused, internal: unused.filter((name) => model.packages.some((p) => p.ecosystem === "python" && normalise(p.name) === normalise(name))) }),
      );
    }
  }
  return findings;
}

/** Python distributions: `pyproject.toml` packages, with the modules and names outside the underscore and `__all__` markers as their public surface. */
export const language: PackagingLanguage = { id: "python", readEntries, manifestChecks };

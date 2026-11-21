import { compareIds } from "@code-health/graph/graph";
import { isConfigPath, SpecifierResolver } from "@code-health/parse/resolve-specifier";
import type { PackageModel } from "./model.ts";

/** The files through which a package is meant to be used. */
export interface PackageEntries {
  id: string;
  /** Files a consumer may import: what `exports`, `main` or `module` name. */
  files: ReadonlySet<string>;
  /** The package's `exports` map has a pattern, such as `./*`, so any file it matches is public. */
  wildcard: boolean;
  /** The manifest limits its public files with `exports`. Without it, every path under the package can be imported. */
  hasExportsMap: boolean;
}

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
export async function readEntries(model: PackageModel): Promise<Map<string, PackageEntries>> {
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

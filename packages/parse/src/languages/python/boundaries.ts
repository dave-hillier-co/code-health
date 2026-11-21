import { posix } from "node:path";
import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";
import { parseToml, type TomlTable, type TomlValue } from "../../toml.ts";

const isManifest = (path: string): boolean => path === "pyproject.toml" || path.endsWith("/pyproject.toml");

const table = (value: TomlValue | undefined): TomlTable => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {});
const strings = (value: TomlValue | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * The `__init__.py` of each top-level package under `dir`: its folder holds one and its parent holds none. Private
 * (underscore) and test folders are left out, and so is whatever belongs to a distribution nested deeper.
 */
function topLevelPackages(files: ReadonlySet<string>, dir: string, nested: readonly string[]): string[] {
  const prefix = dir === "." ? "" : `${dir}/`;
  const found: string[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith("/__init__.py")) continue;
    const folder = posix.dirname(file);
    if (folder === dir || nested.some((other) => folder === other || folder.startsWith(`${other}/`))) continue;
    if (files.has(posix.join(posix.dirname(folder), "__init__.py"))) continue;
    if (posix.basename(folder).startsWith("_") || /^tests?$/.test(posix.basename(folder))) continue;
    found.push(file);
  }
  return found;
}

/**
 * Distributions (`pyproject.toml`) are the fixed points of a Python repository. The entries of a distribution
 * that is not marked `Private :: Do Not Upload` are the `__init__.py` of each top-level package under its
 * directory, which is what `import package` runs, and the module of each console script (`module:function`).
 */
export const pythonBoundaries: BoundaryDiscovery = {
  isManifest,
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const manifests = [...tree.files.keys()].filter(isManifest).sort();
    const files = new Set(tree.files.keys());
    const boundaries: Boundary[] = [];
    for (const [path, text] of await tree.readMany(manifests)) {
      const dir = posix.dirname(path);
      const toml = parseToml(text);
      const project = table(toml.project);
      const poetry = table(table(toml.tool).poetry);
      const name = project.name ?? poetry.name;
      const priv = strings(project.classifiers).includes("Private :: Do Not Upload") ? true : null;
      const entries = new Set<string>();
      if (priv !== true) {
        const nested = manifests.map((manifest) => posix.dirname(manifest)).filter((other) => other !== dir && (dir === "." || other.startsWith(`${dir}/`)));
        for (const init of topLevelPackages(files, dir, nested)) entries.add(init);
        for (const scripts of [table(project.scripts), table(poetry.scripts)]) {
          for (const target of Object.values(scripts)) {
            if (typeof target !== "string") continue;
            const module = target.split(":")[0]!.trim().split(".").join("/");
            for (const candidate of [`${module}.py`, `${module}/__init__.py`, `src/${module}.py`, `src/${module}/__init__.py`]) {
              const resolved = posix.normalize(dir === "." ? candidate : posix.join(dir, candidate));
              if (files.has(resolved)) entries.add(resolved);
            }
          }
        }
      }
      boundaries.push({ dir, manifest: path, name: typeof name === "string" ? name : null, private: priv, entryFiles: [...entries].sort() });
    }
    for (const path of manifests) if (!boundaries.some((boundary) => boundary.manifest === path)) boundaries.push({ dir: posix.dirname(path), manifest: path, name: null, private: null, entryFiles: [] });
    return boundaries.sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0));
  },
};

import { posix } from "node:path";
import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringLeaves(item, out);
}

function patternMatcher(path: string): RegExp {
  const source = path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`);
}

const isManifest = (path: string): boolean => path === "package.json" || path.endsWith("/package.json");

/**
 * Packages are the fixed points of a TypeScript or JavaScript repository. The entries of a non-private
 * package are the files its manifest publishes as `main`, `module`, `types`, `typings`, `bin` or `exports`.
 * A target with `*` (an `exports` subpath pattern) publishes every file in the tree it matches, where `*`
 * stands for any run of characters, `/` included, as in Node's own matching.
 */
export const typescriptBoundaries: BoundaryDiscovery = {
  isManifest,
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const manifests = [...tree.files.keys()].filter(isManifest).sort();
    const boundaries: Boundary[] = [];
    for (const [path, text] of await tree.readMany(manifests)) {
      const directory = posix.dirname(path);
      let manifest: Record<string, unknown> | undefined;
      try {
        manifest = JSON.parse(text) as Record<string, unknown>;
      } catch {
        manifest = undefined;
      }
      if (manifest === undefined || typeof manifest !== "object" || manifest === null) {
        boundaries.push({ dir: directory, manifest: path, name: null, private: null, entryFiles: [] });
        continue;
      }
      const entries = new Set<string>();
      if (manifest.private !== true) {
        const targets: string[] = [];
        for (const key of ["main", "module", "types", "typings", "bin", "exports"]) stringLeaves(manifest[key], targets);
        for (const target of targets) {
          const resolved = posix.normalize(directory === "." ? target : posix.join(directory, target));
          if (target.includes("*")) {
            const matches = patternMatcher(resolved);
            for (const file of tree.files.keys()) if (matches.test(file)) entries.add(file);
          } else if (tree.files.has(resolved)) entries.add(resolved);
        }
      }
      boundaries.push({
        dir: directory,
        manifest: path,
        name: typeof manifest.name === "string" ? manifest.name : null,
        private: typeof manifest.private === "boolean" ? manifest.private : null,
        entryFiles: [...entries].sort(),
      });
    }
    return boundaries;
  },
};

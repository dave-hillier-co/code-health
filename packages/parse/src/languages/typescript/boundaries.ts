import { posix } from "node:path";
import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringLeaves(item, out);
}

const isManifest = (path: string): boolean => path === "package.json" || path.endsWith("/package.json");

/**
 * Packages are the fixed points of a TypeScript or JavaScript repository. The entries of a non-private
 * package are the files its manifest publishes as `main`, `module`, `types`, `typings`, `bin` or `exports`,
 * leaving out patterns, which name no single file.
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
          if (target.includes("*")) continue;
          const resolved = posix.normalize(directory === "." ? target : posix.join(directory, target));
          if (tree.files.has(resolved)) entries.add(resolved);
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

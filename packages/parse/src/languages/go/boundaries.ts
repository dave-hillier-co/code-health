import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";
import { isGoModFile, parseGoMod } from "./go-mod.ts";

/**
 * Modules are the fixed points of a Go repository: a `go.mod` is the manifest, and its `module` directive
 * the name. A go.mod does not say what is published, so a module is neither private nor has entry files:
 * every package outside `internal/` can be imported by another module.
 *
 * `internal/` directories are fixed points of a second kind, which the compiler enforces on imports: code
 * outside the parent of an `internal` directory cannot import what is under it. They are not manifests, so
 * the mover enforces them where it rewrites imports (see locality's Go mover), and packaging reads them as
 * the language's internals marker.
 */
export const goBoundaries: BoundaryDiscovery = {
  isManifest: isGoModFile,
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const manifests = [...tree.files.keys()].filter(isGoModFile).sort();
    const boundaries: Boundary[] = [];
    for (const [path, text] of await tree.readMany(manifests)) {
      const module = parseGoMod(path, text);
      boundaries.push({ dir: module.dir, manifest: path, name: module.path, private: null, entryFiles: [] });
    }
    return boundaries;
  },
};

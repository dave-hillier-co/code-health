import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";
import { isManifestPath, readCrates } from "./crates.ts";

/**
 * Crates are the fixed points of a Rust repository: one per `Cargo.toml`, the manifest of a workspace
 * included. The entries of a crate that is not `publish = false` are its library root and its binaries' roots,
 * the files other crates and users reach it through. What the library exposes beyond its root is a matter
 * of `pub mod`, which the packaging skill reads.
 */
export const rustBoundaries: BoundaryDiscovery = {
  isManifest: isManifestPath,
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const manifests = [...tree.files.keys()].filter(isManifestPath).sort();
    const configs = await tree.readMany(manifests);
    const crates = readCrates([...tree.files.keys()], configs);
    return crates.map((crate) => ({
      dir: crate.dir,
      manifest: crate.manifest,
      name: crate.name,
      private: crate.private,
      entryFiles: crate.private === true ? [] : [...new Set([...(crate.libRoot === undefined ? [] : [crate.libRoot]), ...crate.binRoots])].sort(),
    }));
  },
};

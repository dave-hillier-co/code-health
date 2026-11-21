import { posix } from "node:path";
import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";
import { parseCmake, publicHeaders } from "./cmake.ts";
import { isHeader } from "./extensions.ts";

const isManifest = (path: string): boolean => path === "CMakeLists.txt" || path.endsWith("/CMakeLists.txt");

/**
 * Build targets are the fixed points of a C++ repository: one boundary per CMakeLists.txt. Its name is the
 * first target (or the project, for a file that only adds subdirectories). A directory whose targets are all
 * executables is private, since nothing links to one. The entries of the others are the headers under the
 * include directories its libraries make `PUBLIC` or `INTERFACE`, which is what a consumer can include.
 * Build systems other than CMake are not read.
 */
export const cppBoundaries: BoundaryDiscovery = {
  isManifest,
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const manifests = [...tree.files.keys()].filter(isManifest).sort();
    const paths = [...tree.files.keys()];
    const boundaries: Boundary[] = [];
    for (const [path, text] of await tree.readMany(manifests)) {
      const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
      const parsed = parseCmake(text);
      const onlyExecutables = parsed.targets.length > 0 && parsed.targets.every((target) => target.kind === "executable");
      boundaries.push({
        dir: dir === "" ? "." : dir,
        manifest: path,
        name: parsed.targets[0]?.name ?? parsed.project,
        private: onlyExecutables ? true : null,
        entryFiles: onlyExecutables ? [] : publicHeaders(dir, parsed, paths, isHeader).files,
      });
    }
    return boundaries;
  },
};

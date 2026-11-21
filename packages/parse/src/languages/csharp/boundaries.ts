import { posix } from "node:path";
import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";
import { isProjectFile, isSolutionFile, projectProperty } from "./projects.ts";

const stem = (path: string): string => posix.basename(path).replace(/\.[^.]+$/, "");

/**
 * Projects and solutions are the fixed points of a C# repository. A project's name is its `AssemblyName`,
 * or its file name, and it is private when it says `IsPackable` is false. No file is an entry point: an
 * assembly exposes types by namespace and not by path, so moving a file changes nothing a consumer sees.
 * A solution only groups projects, so it names a boundary without entries.
 */
export const csharpBoundaries: BoundaryDiscovery = {
  isManifest: (path) => isProjectFile(path) || isSolutionFile(path),
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const manifests = [...tree.files.keys()].filter((path) => isProjectFile(path) || isSolutionFile(path)).sort();
    const texts = await tree.readMany(manifests.filter(isProjectFile));
    return manifests.map((manifest) => {
      const dir = posix.dirname(manifest);
      if (isSolutionFile(manifest)) return { dir, manifest, name: stem(manifest), private: null, entryFiles: [] };
      const text = texts.get(manifest);
      if (text === undefined) return { dir, manifest, name: null, private: null, entryFiles: [] };
      const packable = projectProperty(text, "IsPackable");
      return {
        dir,
        manifest,
        name: projectProperty(text, "AssemblyName") ?? stem(manifest),
        private: packable === undefined ? null : packable.toLowerCase() === "false",
        entryFiles: [],
      };
    });
  },
};

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceTree } from "./source-tree.ts";

/**
 * The `compile_commands.json` a build left on disk, which git usually does not track. CMake writes it into the build
 * directory (`CMAKE_EXPORT_COMPILE_COMMANDS=ON`), so these places are tried in order: the repository root, `build/`,
 * `out/`, each `cmake-build-*` directory, and the directories one level below `build/` and `out/` (per-preset build
 * directories, `out/build/<preset>`). The first that exists and holds a JSON array with at least one entry is read.
 * It is read whether or not git tracks it. A file the tree tracks is not read here: `analyseTree` reads it from the tree.
 *
 * Returns a map from repo-relative path to text with one entry, or an empty map when there is none or the tree already
 * tracks a `compile_commands.json`.
 */
export function readBuildConfigs(root: string, tree: Pick<SourceTree, "files">): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of tree.files.keys()) if (path === "compile_commands.json" || path.endsWith("/compile_commands.json")) return found;
  for (const directory of candidateDirectories(root)) {
    const path = directory === "" ? "compile_commands.json" : `${directory}/compile_commands.json`;
    const text = readIfCompileCommands(join(root, path));
    if (text !== undefined) {
      found.set(path, text);
      return found;
    }
  }
  return found;
}

function subdirectories(root: string, directory: string): string[] {
  try {
    return readdirSync(join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function candidateDirectories(root: string): string[] {
  const directories = ["", "build", "out"];
  directories.push(...subdirectories(root, "").filter((name) => name.startsWith("cmake-build-")));
  for (const parent of ["build", "out"]) {
    for (const child of subdirectories(root, parent)) {
      directories.push(`${parent}/${child}`);
      if (parent === "out" && child === "build") for (const preset of subdirectories(root, "out/build")) directories.push(`out/build/${preset}`);
    }
  }
  return directories;
}

function readIfCompileCommands(file: string): string | undefined {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return undefined;
    const text = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

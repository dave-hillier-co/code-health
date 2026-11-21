import { accessSync, constants, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

/**
 * The full path of an executable file found on the search path, or undefined. One definition of "installed"
 * for the product (a language's optional tools) and for the tests that need them, so the two never disagree.
 */
export function findExecutable(executable: string, searchPath: string | undefined = process.env.PATH): string | undefined {
  for (const directory of (searchPath ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * True when the executable is found and exits 0 for `args` (a version command). A shim of a tool that is not
 * installed (a rustup proxy, an Xcode stub) is found on the path and fails here.
 */
export function executableWorks(executable: string, args: readonly string[], searchPath: string | undefined = process.env.PATH): boolean {
  const found = findExecutable(executable, searchPath);
  if (found === undefined) return false;
  return spawnSync(found, [...args], { stdio: "ignore", timeout: 30_000 }).status === 0;
}

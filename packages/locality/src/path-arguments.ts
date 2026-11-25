import { usageError } from "@code-health/cli-kit/errors";
import { repoRelative } from "@code-health/history/repo-paths";

/** Path arguments as repository-relative paths with no trailing slash: an absolute path inside the repository is relativised. */
export function pathArguments(root: string, positionals: readonly string[]): string[] {
  return positionals.map((raw) => repoRelative(root, raw).replace(/\/+$/, ""));
}

/** Throws a usage error for a path argument that is neither one of the files nor a folder holding one. */
export function requireMatches(prefixes: readonly string[], files: Iterable<string>): void {
  const known = [...files];
  for (const prefix of prefixes) {
    if (prefix === "" || prefix === ".") continue;
    if (!known.some((file) => file === prefix || file.startsWith(`${prefix}/`))) {
      throw usageError(`"${prefix}" matches no file the analyser read: name a path inside the repository, relative to its root or absolute`);
    }
  }
}

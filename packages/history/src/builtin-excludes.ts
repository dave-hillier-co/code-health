import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_EXCLUDE_GLOBS, NESTED_CHECKOUT_ENTRY, recordBuiltinOmission } from "@code-health/cli-kit/builtin-excludes";
import { compileGlobs } from "./glob.ts";

const matchers = BUILTIN_EXCLUDE_GLOBS.map((glob) => ({ glob, matches: compileGlobs([glob]) }));

/**
 * The built-in excludes of one repository as a predicate on repo-relative POSIX paths. A path is omitted when
 * it matches a built-in glob, or lies below a directory that is its own git checkout: one that contains a
 * `.git` file or directory on disk (linked worktrees, nested clones), or a submodule (`gitlinks`, the paths
 * the tree records as commits). The repository root is not below itself, so it is never omitted.
 * Every omission is recorded, so the command can report how many files each entry omitted, unless `record` is
 * false, for a caller that only asks whether a path is omitted.
 */
export function builtinExcluder(root: string, gitlinks: Iterable<string> = [], options: { record?: boolean } = {}): (path: string) => boolean {
  const record = options.record ?? true;
  const links = new Set(gitlinks);
  const checkouts = new Map<string, boolean>();
  const isCheckout = (directory: string): boolean => {
    let answer = checkouts.get(directory);
    if (answer === undefined) {
      answer = links.has(directory) || existsSync(join(root, directory, ".git"));
      checkouts.set(directory, answer);
    }
    return answer;
  };
  return (path) => {
    for (const { glob, matches } of matchers) {
      if (matches(path)) {
        if (record) recordBuiltinOmission(glob, path);
        return true;
      }
    }
    if (links.has(path)) {
      if (record) recordBuiltinOmission(NESTED_CHECKOUT_ENTRY, path);
      return true;
    }
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (isCheckout(path.slice(0, slash))) {
        if (record) recordBuiltinOmission(NESTED_CHECKOUT_ENTRY, path);
        return true;
      }
    }
    return false;
  };
}

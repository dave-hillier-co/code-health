import { compileGlobs } from "@code-health/history/glob";
import { isTestPath } from "./languages.ts";

/** What a file is for. A file is a test by its language's naming conventions, or by the config's `testPatterns`. */
export type Role = "production" | "test";

/**
 * Decides whether a path is a test. The owning language adapter's conventions give the default (`isTestPath`), and each
 * entry of `testPatterns` is laid over it in order: a glob makes a matching file a test, a glob with a leading `!` makes
 * it production, and the last entry that matches wins.
 */
export function testClassifier(patterns: readonly string[] = []): (path: string) => boolean {
  const entries = patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "" && !pattern.startsWith("#"))
    .map((pattern) => (pattern.startsWith("!") ? { test: false, matches: compileGlobs([pattern.slice(1)]) } : { test: true, matches: compileGlobs([pattern]) }));
  return (path) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]!.matches(path)) return entries[index]!.test;
    }
    return isTestPath(path);
  };
}

export const roleOf = (isTest: boolean): Role => (isTest ? "test" : "production");

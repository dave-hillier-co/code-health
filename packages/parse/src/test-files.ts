import { compileGlobs } from "@code-health/history/glob";
import { isTestPath } from "./languages.ts";

/** What a file is for. A file is a test by its language's naming conventions, or by the config's `testPatterns`. */
export type Role = "production" | "test";

/** The folder names that hold test code, each a whole folder name. Matched case-insensitively. */
export const TEST_FOLDER_NAMES: readonly string[] = [
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "mocks",
  "testing",
  "testutil",
  "testutils",
  "testhelper",
  "testhelpers",
  "testsupport",
  "testfixture",
  "testfixtures",
  "integrationtesting",
  "e2e",
  "testdata",
];

const SUPPORT_FOLDER = new RegExp(`(^|/)(${TEST_FOLDER_NAMES.join("|")})/`, "i");

/**
 * Test-support code by folder, whatever the language: a folder named `test`, `tests`, `__tests__`, `__mocks__`, `mocks`,
 * `testing`, `testutil`, `testutils`, `testhelper`, `testhelpers`, `testsupport`, `testfixtures`, `integrationtesting`,
 * `e2e` or `testdata`. Language adapters only know their own file naming (Go `_test.go`), so a Go helper in `pkg/datastore/test/`
 * is not a test by name. The names are whole folder names, never a part of one, so `contest/` and `latest/` do not
 * match. `testing` is also the name of Go's standard package, but a folder of that name in a repository holds helpers
 * for tests in practice; a repository where it holds production code lists a negated entry such as `!pkg/testing/*` in `testPatterns`.
 * `testdata` is the folder the Go tool ignores and Go tests read their inputs from, and other languages use the name
 * the same way, so a script kept there as a test input is not ranked as production code.
 */
export const isTestSupportFolder = (path: string): boolean => SUPPORT_FOLDER.test(path.slice(0, path.lastIndexOf("/") + 1));

/**
 * Decides whether a path is a test. The owning language adapter's conventions and the support folders give the default
 * (`isTestPath`, `isTestSupportFolder`), and each entry of `testPatterns` is laid over it in order: a glob makes a matching file a test, a glob with a leading `!` makes
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
    return isTestPath(path) || isTestSupportFolder(path);
  };
}

export const roleOf = (isTest: boolean): Role => (isTest ? "test" : "production");

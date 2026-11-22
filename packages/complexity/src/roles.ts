import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { Role } from "@code-health/parse/test-files";

export type { Role };

/** `--include-tests` puts the test code in the one list. Without it rows are production code, and the tests are counted. */
export const includeTestsOption = { "include-tests": { type: "boolean" } } as const;

export const includeTestsHelp = "list test code in the same ranking as production code (default: production first, with the tests counted apart and, in the JSON, listed in `tests`); a file is a test by its language's naming conventions and the shared `testPatterns`";

export const wantsTests = (context: CommandContext): boolean => context.values["include-tests"] === true;

export const roleOfTest = (test: boolean): Role => (test ? "test" : "production");

/** How many test rows the JSON lists beside the production rows when they are not merged in. */
export const TEST_ROWS_LISTED = 10;

/**
 * Splits rows, already in their order, into the ones a run lists and the tests it sets apart. With `include`, nothing is
 * set apart. The tests section says how many tests there are, lists the first few in the same order, and counts the rest.
 */
export function splitRoles<Row extends { role: Role }>(rows: readonly Row[], include: boolean): { listed: Row[]; tests: { count: number; listed: number; omitted: number; rows: Row[] } | null } {
  if (include) return { listed: [...rows], tests: null };
  const tests = rows.filter((row) => row.role === "test");
  const shown = tests.slice(0, TEST_ROWS_LISTED);
  return {
    listed: rows.filter((row) => row.role === "production"),
    tests: { count: tests.length, listed: shown.length, omitted: tests.length - shown.length, rows: shown },
  };
}

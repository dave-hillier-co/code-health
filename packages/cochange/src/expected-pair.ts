/** Why a coupled pair says little. */
export type ExpectedReason = "test" | "fixture-or-golden" | "same-format-data";

/** What each reason prints in the report. */
export const EXPECTED_LABEL: Record<ExpectedReason, string> = {
  test: "a test and the code it tests",
  "fixture-or-golden": "a fixture or golden file and what it checks",
  "same-format-data": "two data or configuration files of one format",
};

/** The order the reasons are checked and counted in. */
export const EXPECTED_REASONS: readonly ExpectedReason[] = ["test", "fixture-or-golden", "same-format-data"];

const FIXTURE_FOLDER = /(^|\/)(testdata|test-data|fixtures?|__fixtures__|__snapshots__|__mocks__|snapshots?|goldens?|golden-files)\//i;
const FIXTURE_NAME = /[._-](golden|snap|approved|received)(\.[^/.]+)?$/i;

/** A fixture or golden file by folder or by name: `testdata/`, `goldens/`, `__snapshots__/`, `x.golden`, `x.snap`, `x.approved.txt`. */
export function isFixturePath(path: string): boolean {
  return FIXTURE_FOLDER.test(path) || FIXTURE_NAME.test(path);
}

const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

interface Side {
  path: string;
  /** Whether the file is code, as the language configuration says. */
  code: boolean;
}

/**
 * Why a pair is expected, or null when it is a pair of production files. A pair is expected when either side is a
 * test (by naming convention and the shared `testPatterns`, passed as `isTest`), when either side is a fixture or a
 * golden file, or when both sides are non-code files of one format, such as two workflow files, two scene files or
 * a compose file and its variant. Expected pairs are listed apart from the others, never dropped.
 */
export function expectedReason(a: Side, b: Side, isTest: (path: string) => boolean): ExpectedReason | null {
  if (isTest(a.path) || isTest(b.path)) return "test";
  if (isFixturePath(a.path) || isFixturePath(b.path)) return "fixture-or-golden";
  if (!a.code && !b.code && extension(a.path) === extension(b.path)) return "same-format-data";
  return null;
}

import { recordDropped } from "@code-health/cli-kit/dropped-files";
import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { listTree } from "@code-health/history/tree";
import { isCodePath } from "@code-health/parse/code-files";
import { testClassifier } from "@code-health/parse/test-files";
import { readComponents } from "./components.ts";
import { componentUnits, fileUnits, type By, type Unit } from "./file-statistics.ts";
import type { LoadedHistory } from "./history-access.ts";

export const SECONDS_PER_DAY = 86_400;

export const isoDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

export const byOption = { by: { type: "string" } } as const;

/** `--all-files` ranks the files that are not code as well. Without it a ranking holds code only. */
export const allFilesOption = { "all-files": { type: "boolean" } } as const;

/** True when the run states `--all-files`. Commands that do not offer the option rank code only. */
export const wantsAllFiles = (context: CommandContext): boolean => context.values["all-files"] === true;

/** `--include-tests` ranks the test files with the production code. Without it a ranking holds production code and counts the tests it left out. */
export const includeTestsOption = { "include-tests": { type: "boolean" } } as const;

/** True when the run states `--include-tests`. Commands that do not offer the option leave tests out. */
export const wantsTests = (context: CommandContext): boolean => context.values["include-tests"] === true;

/** The `--by` view: files, unless components are asked for. */
export function readBy(context: CommandContext): By {
  const value = context.values.by;
  if (value === undefined) return "file";
  if (value === "file" || value === "component") return value;
  throw usageError(`--by must be "file" or "component", not "${String(value)}"`);
}

/** A grouped view is a slice of the repository's answer, so it is printed but not stored as the report. */
export const isGrouped = (context: CommandContext): boolean => readBy(context) !== "file";

/**
 * The files or components of the history, restricted to files that still exist at the analysed commit and, unless
 * `--all-files` is stated, to code: a file that a language adapter or a lexical profile claims. The non-code files
 * that changed in the window and exist at the commit are counted in `dropped.nonCode`. Test files (the language's naming
 * conventions and the shared `testPatterns`) are left out when `omitTests` is set (the hotspot ranking) unless `--include-tests` is stated, and counted the same way in `dropped.tests`.
 */
export async function loadUnits(context: CommandContext, history: LoadedHistory, by: By = readBy(context), omitTests = false): Promise<Unit[]> {
  const present = new Set(await listTree(context.repo.root, history.view.headSha));
  const { changes } = history.filtered;
  if (!wantsAllFiles(context)) {
    const languages = context.config.effective.languages;
    const touched = new Set(changes.flatMap((change) => change.files.map((file) => file.fileId)));
    for (const path of [...present]) {
      if (isCodePath(path, languages)) continue;
      present.delete(path);
      if (touched.has(path)) recordDropped("nonCode", path);
    }
  }
  if (omitTests && !wantsTests(context)) {
    const isTest = testClassifier(context.config.effective.testPatterns);
    const touched = new Set(changes.flatMap((change) => change.files.map((file) => file.fileId)));
    for (const path of [...present]) {
      if (!isTest(path)) continue;
      present.delete(path);
      if (touched.has(path)) recordDropped("tests", path);
    }
  }
  return by === "file"
    ? fileUnits(changes, present)
    : componentUnits(changes, present, readComponents(context.config.effective.components));
}

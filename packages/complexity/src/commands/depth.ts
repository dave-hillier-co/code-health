import type { Command, CommandContext, Rule } from "@code-health/cli-kit/run-cli";
import { measureCurrent, storeReport } from "../analysis.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { depthRows, passThroughCount } from "../interface-depth.ts";
import { includeTestsHelp, includeTestsOption, splitRoles, wantsTests } from "../roles.ts";
import { ruleDescriptions } from "../rules.ts";
import { skipReport } from "@code-health/history/reports";

export const name = "depth";

export const rules: Record<string, Rule> = ruleDescriptions;

/** Whether a run covers less than the whole repository, so it is printed but never stored as a report. */
function isPartial(context: CommandContext): boolean {
  return context.positionals.length > 0 || wantsTests(context);
}

/**
 * The interface depth signal: exported functions, classes and modules by depth, shallowest first, with
 * the exported pass-throughs ranked above them. A pass-through that is not exported has no row and is counted in the
 * summary. Tests are set apart unless `--include-tests` is given. The structural layer only, because depth needs the syntax tree.
 * A whole-repository run on a clean tree stores `complexity.depth`.
 */
export const command: Command = {
  summary: "Rank exported functions, classes and modules by interface depth, exported pass-throughs first, with the tests counted apart",
  options: { ...includeTestsOption },
  optionHelp: { "include-tests": includeTestsHelp },
  async run(context) {
    const { settings, current, measurement } = await measureCurrent(context, "structural");
    const paths = normalisePaths(context.positionals);
    const inPaths = pathSelector(paths);
    const files = measurement.files.filter((file) => inPaths(file.path));
    const all = files.flatMap((file) => depthRows(file, settings.shallowDepth)).sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const { listed: rows, tests } = splitRoles(all, wantsTests(context));

    const summary = {
      files: files.filter((file) => file.interfaces !== undefined).length,
      filesWithoutAdapter: files.filter((file) => file.interfaces === undefined).length,
      rows: rows.length,
      shallow: rows.filter((row) => row.labels.includes("shallow")).length,
      passThrough: rows.filter((row) => row.passThrough !== null).length,
      /** Pass-through functions with no row because the language does not export them. */
      passThroughNotExported: files.reduce((sum, file) => sum + passThroughCount(file), 0) - all.filter((row) => row.passThrough !== null && row.kind !== "module").length,
    };
    const output = {
      inputs: { tree: current.kind, paths, shallow: settings.shallowDepth, includeTests: wantsTests(context) },
      extra: { summary, ...(tests === null ? {} : { tests }), skippedFiles: measurement.skippedFiles },
      results: rows,
      columns: ["path", "unit", "kind", "role", "exported", "nodes", "interface", "depth", "passThrough", "labels"],
      notices: tests === null || tests.count === 0 ? [] : [`${tests.count} test rows are not listed (--include-tests lists them with the production code, and the JSON has the first ${tests.listed} in \`tests\`)`],
    };
    if (!isPartial(context) && current.kind === "head") await storeReport(context, name, output);
    else skipReport(context, current.kind === "head" ? "the run was limited by arguments or options" : "the run did not analyse HEAD");
    return output;
  },
};

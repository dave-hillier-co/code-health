import type { Command, CommandContext, Rule } from "@code-health/cli-kit/run-cli";
import { measureCurrent, storeReport } from "../analysis.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { depthRows } from "../interface-depth.ts";
import { ruleDescriptions } from "../rules.ts";

export const name = "depth";

export const rules: Record<string, Rule> = ruleDescriptions;

/** Whether a run covers less than the whole repository, so it is printed but never stored as a report. */
function isPartial(context: CommandContext): boolean {
  return context.positionals.length > 0;
}

/**
 * The interface depth signal: exported functions, classes and modules by depth, shallowest first, with
 * every pass-through ranked above them. The structural layer only, because depth needs the syntax tree.
 * A whole-repository run on a clean tree stores `complexity.depth`.
 */
export const command: Command = {
  summary: "Rank exported functions, classes and modules by interface depth, and list pass-through functions",
  async run(context) {
    const { settings, current, measurement } = await measureCurrent(context, "structural");
    const paths = normalisePaths(context.positionals);
    const inPaths = pathSelector(paths);
    const files = measurement.files.filter((file) => inPaths(file.path));
    const rows = files.flatMap((file) => depthRows(file, settings.shallowDepth));

    const summary = {
      files: files.filter((file) => file.interfaces !== undefined).length,
      filesWithoutAdapter: files.filter((file) => file.interfaces === undefined).length,
      rows: rows.length,
      shallow: rows.filter((row) => row.labels.includes("shallow")).length,
      passThrough: rows.filter((row) => row.passThrough !== null).length,
    };
    const output = {
      inputs: { tree: current.kind, paths, shallow: settings.shallowDepth },
      extra: { summary, skippedFiles: measurement.skippedFiles },
      results: rows,
      columns: ["path", "unit", "kind", "nodes", "interface", "depth", "passThrough", "labels"],
    };
    if (!isPartial(context) && current.kind === "head") await storeReport(context, name, output);
    return output;
  },
};

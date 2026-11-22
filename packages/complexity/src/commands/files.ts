import type { Command, CommandContext } from "@code-health/cli-kit/run-cli";
import { layerOption, measureCurrent, parseLayer, storeReport } from "../analysis.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { fileRow } from "../rows.ts";
import { skipReport } from "@code-health/history/reports";

export const name = "files";

/** Whether a run covers less than the whole repository, so it is printed but never stored as a report. */
function isPartial(context: CommandContext): boolean {
  return context.positionals.length > 0 || context.values.layer !== undefined;
}

/**
 * File-level aggregates. A whole-repository run on a clean tree stores `complexity.files`, which the
 * cochange plugin reads: each row's `complexity` is the file's indentation complexity, the definition
 * shared with cochange's own proxy.
 */
export const command: Command = {
  summary: "File-level aggregates; a full run writes the complexity.files report other plugins read",
  options: { ...layerOption },
  async run(context) {
    const layer = parseLayer(context.values.layer);
    const { settings, current, measurement } = await measureCurrent(context, layer);
    const paths = normalisePaths(context.positionals);
    const inPaths = pathSelector(paths);
    const rows = measurement.files.filter((file) => inPaths(file.path)).map((file) => fileRow(file, settings));
    const output = {
      inputs: { tree: current.kind, layer, paths },
      extra: { skippedFiles: measurement.skippedFiles },
      results: rows,
      columns: ["path", "complexity", "functions", "aboveGuideline", "source", "profile", "test", "codeLines"],
    };
    if (!isPartial(context) && current.kind === "head") await storeReport(context, name, output);
    else skipReport(context, current.kind === "head" ? "the run was limited by arguments or options" : "the run did not analyse HEAD");
    return output;
  },
};

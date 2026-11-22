import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { cachedAnalysis, layerOption, measureCurrent, noCacheHelp, noCacheOption, parseLayer } from "../analysis.ts";
import type { Layer } from "../measure.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { fileRow } from "../rows.ts";
import { recordDropped } from "@code-health/cli-kit/dropped-files";
import { isCodePath } from "@code-health/parse/code-files";

export const name = "files";

/**
 * File-level aggregates of the code: files that a language adapter or a lexical profile claims. The files that are
 * not code are counted in `dropped.nonCode`. A run on a clean tree stores its result, and the whole-repository run
 * stores `complexity.files`, which the cochange plugin reads: each row's `complexity` is the file's indentation
 * complexity, the definition shared with cochange's own proxy.
 */
export const command: Command = {
  summary: "File-level aggregates; a full run writes the complexity.files report other plugins read",
  options: { ...layerOption, ...noCacheOption },
  optionHelp: { "no-cache": noCacheHelp },
  run(context) {
    const layer = parseLayer(context.values.layer);
    const paths = normalisePaths(context.positionals);
    return cachedAnalysis(context, name, { layer: context.values.layer, paths: paths.length === 0 ? undefined : paths }, () => compute(context, layer, paths));
  },
};

async function compute(context: CommandContext, layer: Layer, paths: string[]): Promise<CommandOutput> {
  const { settings, current, measurement } = await measureCurrent(context, layer);
  const inPaths = pathSelector(paths);
  const rows = measurement.files
    .filter((file) => inPaths(file.path))
    .filter((file) => {
      if (isCodePath(file.path, settings.languageProfiles)) return true;
      recordDropped("nonCode", file.path);
      return false;
    })
    .map((file) => fileRow(file, settings));
  return {
    inputs: { tree: current.kind, layer, paths },
    extra: { skippedFiles: measurement.skippedFiles },
    results: rows,
    columns: ["path", "complexity", "functions", "aboveGuideline", "source", "profile", "test", "codeLines"],
  };
}

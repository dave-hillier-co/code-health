import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { cachedAnalysis, layerOption, measureCurrent, noCacheHelp, noCacheOption, parseLayer } from "../analysis.ts";
import type { Layer } from "../measure.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { fileRow } from "../rows.ts";
import { includeTestsHelp, includeTestsOption, wantsTests } from "../roles.ts";
import { recordDropped } from "@code-health/cli-kit/dropped-files";
import { isCodePath } from "@code-health/parse/code-files";
import { withNonProductionFolders } from "@code-health/parse/non-production-folders";

export const name = "files";

type FileRow = { path: string; role: string; score: number; functions: number };

function byMeasuredThenScore(a: FileRow, b: FileRow): number {
  return Number(b.functions > 0) - Number(a.functions > 0) || b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

/**
 * File-level aggregates of the code: files that a language adapter or a lexical profile claims. The files that are
 * not code are counted in `dropped.nonCode`. A run on a clean tree stores its result, and the whole-repository run
 * stores `complexity.files`, which the cochange plugin reads: each row's `complexity` is the file's indentation
 * complexity, the definition shared with cochange's own proxy. The list ranks the files with a measured function first,
 * by complexity, then the files with none (declarations, data), so its top row is a file `explain` and `report xray` can break down.
 */
export const command: Command = {
  summary: "File-level aggregates; a full run writes the complexity.files report other plugins read",
  options: { ...layerOption, ...includeTestsOption, ...noCacheOption },
  optionHelp: { "include-tests": includeTestsHelp, "no-cache": noCacheHelp },
  async run(context) {
    const layer = parseLayer(context.values.layer);
    const paths = normalisePaths(context.positionals);
    // The stored result holds every file, tests included with their role, because cochange reads a complexity for each file it ranks.
    const all = await cachedAnalysis(context, name, { layer: context.values.layer, paths: paths.length === 0 ? undefined : paths }, () => compute(context, layer, paths));
    const rows = all.results as FileRow[];
    const listed = wantsTests(context) ? rows : rows.filter((row) => row.role === "production");
    if (listed.length < rows.length) for (const row of rows) if (row.role === "test") recordDropped("tests", row.path);
    const production = rows.filter((row) => row.role === "production").map((row) => row.path);
    return withNonProductionFolders({ ...all, inputs: { ...all.inputs, includeTests: wantsTests(context) }, results: [...listed].sort(byMeasuredThenScore), presorted: true }, production);
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
    inputs: { tree: current.kind, layer, paths, includeTests: true },
    extra: { skippedFiles: measurement.skippedFiles },
    results: rows,
    columns: ["path", "complexity", "functions", "aboveGuideline", "source", "profile", "role", "codeLines"],
  };
}

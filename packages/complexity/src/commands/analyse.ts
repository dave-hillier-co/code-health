import type { Command, CommandContext, Rule } from "@code-health/cli-kit/run-cli";
import { readChangeWeights } from "../change-weights.ts";
import { layerOption, measureCurrent, metricsOption, parseLayer, parseMetrics, storeReport } from "../analysis.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { fixFigures, fixHeader, fixNotices, fixOptionHelp, fixOptions, measureFixesFor } from "../fix-report.ts";
import { metricIds } from "../metrics.ts";
import { usageError } from "@code-health/cli-kit/errors";
import { rankByValues, rankUnits, type RankBy } from "../ranking.ts";
import { ruleDescriptions } from "../rules.ts";
import { unitRow } from "../rows.ts";
import { skipReport } from "@code-health/history/reports";

export const name = "analyse";

export const rules: Record<string, Rule> = ruleDescriptions;

/** Whether a run covers less than the whole repository, so it is printed but never stored as a report. */
function isPartial(context: CommandContext): boolean {
  return context.positionals.length > 0 || context.values.metrics !== undefined || context.values.layer !== undefined || context.values.by !== undefined || context.values["with-fixes"] === true;
}

function parseBy(value: unknown): RankBy {
  if (value === undefined) return "complexity";
  if ((rankByValues as readonly unknown[]).includes(value)) return value as RankBy;
  throw usageError(`--by must be ${rankByValues.join(" or ")}, got "${String(value)}"`);
}

export const command: Command = {
  summary: "Rank the functions that are hardest to understand (highest metric percentile; --by change-weighted for hotspot order), with all selected metrics, percentiles and labels",
  options: { ...metricsOption, ...layerOption, by: { type: "string" }, "with-fixes": { type: "boolean" }, ...fixOptions },
  optionHelp: {
    by: "what rows sort on: complexity (default, the highest metric percentile) or change-weighted (that percentile times how often the function's file changed in the window, a hotspot order)",
    "with-fixes": "add fixCommits, unitRevisions and fixShare per function from the history window (see `complexity fixes`); costs a parse of the historical revisions",
    ...fixOptionHelp,
  },
  async run(context) {
    const layer = parseLayer(context.values.layer);
    const { settings, current, measurement } = await measureCurrent(context, layer);
    const selected = parseMetrics(context.values.metrics, settings);
    const paths = normalisePaths(context.positionals);
    const inPaths = pathSelector(paths);

    const by = parseBy(context.values.by);
    const changes = settings.changeWeighting ? await readChangeWeights(context, settings) : undefined;
    if (by === "change-weighted" && changes === undefined) {
      throw usageError("--by change-weighted needs change frequency, and there is none: complexity.changeWeighting is off, the clone is shallow, or the repository has no history");
    }
    const ranked = rankUnits(measurement.files.flatMap((file) => file.units), selected, changes, by);
    const unitRows = ranked.filter(({ unit }) => inPaths(unit.path)).map((entry) => unitRow(entry, selected, settings));
    const withFixes = context.values["with-fixes"] === true;
    const fixes = withFixes ? await measureFixesFor(context, settings, current) : undefined;
    const rows = fixes === undefined ? unitRows : unitRows.map((row) => ({ ...row, ...fixFigures(fixes.stats.units.get(row.id)) }));

    const layers = { structural: 0, lexical: 0, none: 0 };
    for (const file of measurement.files) layers[file.source ?? "none"]++;
    const agreement = Object.fromEntries(
      measurement.files.flatMap((file) => (file.agreement === undefined || file.profile === null ? [] : [[file.profile, file.agreement]])),
    );

    // What could not be measured, counted by reason so the output stays small however many files there are.
    const skipped: Record<string, number> = {};
    for (const file of measurement.files) {
      for (const reason of file.skipped) {
        const generic = reason.replace(` for ${file.path}`, "");
        skipped[generic] = (skipped[generic] ?? 0) + 1;
      }
    }

    const output = {
      inputs: {
        tree: current.kind,
        layer,
        metrics: selected,
        by,
        paths,
        ...(fixes === undefined ? {} : { withFixes: true, maxCommits: fixes.request.maxCommits, evidence: fixes.request.evidence }),
      },
      extra: {
        ranking: {
          by,
          basis:
            by === "complexity"
              ? "the highest percentile of any selected metric within the repository, among units measured the same way; the rows also carry changeWeightedScore when history is available"
              : "the highest percentile of any selected metric within the repository, among units measured the same way, times the change weight of the unit's file (fileRevisions counts the file's changes, not the function's)",
          changeWeighted: by === "change-weighted",
          changeWeightsAvailable: changes !== undefined,
          window: changes?.window ?? null,
        },
        layers,
        agreement,
        skipped,
        filesWithSyntaxErrors: measurement.files.filter((file) => file.hasSyntaxErrors).map((file) => file.path),
        skippedFiles: measurement.skippedFiles,
        ...(fixes === undefined ? {} : { fixes: fixHeader(fixes.stats, fixes.request) }),
      },
      results: rows,
      ...(fixes === undefined ? {} : { notices: fixNotices(fixes.stats, fixes.request) }),
      columns: [
        "path",
        "unit",
        "score",
        "complexityScore",
        "changeWeightedScore",
        "fileRevisions",
        "changeWeight",
        "dominant",
        ...metricIds.filter((metric) => selected.includes(metric)),
        ...(fixes === undefined ? [] : ["fixCommits", "unitRevisions", "fixShare"]),
        "labels",
      ],
    };
    if (!isPartial(context) && current.kind === "head") await storeReport(context, name, output);
    else skipReport(context, current.kind === "head" ? "the run was limited by arguments or options" : "the run did not analyse HEAD");
    return output;
  },
};

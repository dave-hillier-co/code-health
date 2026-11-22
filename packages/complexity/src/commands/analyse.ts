import type { Command, CommandContext, Rule } from "@code-health/cli-kit/run-cli";
import { readChangeWeights } from "../change-weights.ts";
import { layerOption, measureCurrent, metricsOption, parseLayer, parseMetrics, storeReport } from "../analysis.ts";
import { normalisePaths, pathSelector } from "../current-tree.ts";
import { fixFigures, fixHeader, fixNotices, fixOptionHelp, fixOptions, measureFixesFor } from "../fix-report.ts";
import { metricIds } from "../metrics.ts";
import { rankUnits } from "../ranking.ts";
import { ruleDescriptions } from "../rules.ts";
import { unitRow } from "../rows.ts";
import { skipReport } from "@code-health/history/reports";

export const name = "analyse";

export const rules: Record<string, Rule> = ruleDescriptions;

/** Whether a run covers less than the whole repository, so it is printed but never stored as a report. */
function isPartial(context: CommandContext): boolean {
  return context.positionals.length > 0 || context.values.metrics !== undefined || context.values.layer !== undefined || context.values["with-fixes"] === true;
}

export const command: Command = {
  summary: "Rank the functions that are hardest to understand, with all selected metrics, percentiles and labels",
  options: { ...metricsOption, ...layerOption, "with-fixes": { type: "boolean" }, ...fixOptions },
  optionHelp: {
    "with-fixes": "add fixCommits, unitRevisions and fixShare per function from the history window (see `complexity fixes`); costs a parse of the historical revisions",
    ...fixOptionHelp,
  },
  async run(context) {
    const layer = parseLayer(context.values.layer);
    const { settings, current, measurement } = await measureCurrent(context, layer);
    const selected = parseMetrics(context.values.metrics, settings);
    const paths = normalisePaths(context.positionals);
    const inPaths = pathSelector(paths);

    const changes = settings.changeWeighting ? await readChangeWeights(context, settings) : undefined;
    const ranked = rankUnits(measurement.files.flatMap((file) => file.units), selected, changes);
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

    // A file a grammar read has its interface shape; one it could not parse cleanly still has one, with syntax errors flagged.
    const parsedFiles = measurement.files.filter((file) => file.interfaces !== undefined).length;
    const filesWithSyntaxErrors = measurement.files.filter((file) => file.hasSyntaxErrors).map((file) => file.path);
    const syntaxErrorShare = parsedFiles === 0 ? 0 : filesWithSyntaxErrors.length / parsedFiles;
    const syntaxErrorNotices =
      parsedFiles > 0 && syntaxErrorShare * 100 > settings.syntaxErrorPercent
        ? [
            `${filesWithSyntaxErrors.length} of ${parsedFiles} parsed files (${(syntaxErrorShare * 100).toFixed(1)}%) have syntax errors, above the complexity.syntaxErrorPercent guideline of ${settings.syntaxErrorPercent}%, so their units may be incomplete or missing; filesWithSyntaxErrors lists them`,
          ]
        : [];

    const output = {
      inputs: {
        tree: current.kind,
        layer,
        metrics: selected,
        paths,
        ...(fixes === undefined ? {} : { withFixes: true, maxCommits: fixes.request.maxCommits, evidence: fixes.request.evidence }),
      },
      extra: {
        ranking: {
          basis:
            changes === undefined
              ? "percentile within the repository, per metric, among units measured the same way"
              : "percentile within the repository, per metric, among units measured the same way, times the change weight of the unit's file",
          changeWeighted: changes !== undefined,
          window: changes?.window ?? null,
        },
        layers,
        agreement,
        skipped,
        parseCoverage: {
          parsedFiles,
          filesWithSyntaxErrors: filesWithSyntaxErrors.length,
          syntaxErrorShare: Math.round(syntaxErrorShare * 10000) / 10000,
          guideline: settings.syntaxErrorPercent,
          aboveGuideline: syntaxErrorNotices.length > 0,
        },
        filesWithSyntaxErrors,
        skippedFiles: measurement.skippedFiles,
        ...(fixes === undefined ? {} : { fixes: fixHeader(fixes.stats, fixes.request) }),
      },
      results: rows,
      ...(fixes === undefined && syntaxErrorNotices.length === 0 ? {} : { notices: [...syntaxErrorNotices, ...(fixes === undefined ? [] : fixNotices(fixes.stats, fixes.request))] }),
      columns: [
        "path",
        "unit",
        "score",
        "revisions",
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

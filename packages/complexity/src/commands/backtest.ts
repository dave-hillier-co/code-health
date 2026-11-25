import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext } from "@code-health/cli-kit/run-cli";
import { analyseHistory, monthsBefore } from "@code-health/history/evidence";
import { findFix } from "@code-health/history/fix-commits";
import { groupByLanding, readLandings } from "@code-health/history/landings";
import { readShallowInfo, refresh } from "@code-health/history/refresh";
import { firstParentLine, sampleByTime, sampleLabels } from "@code-health/history/trend-samples";
import { GrammarSet } from "@code-health/parse/grammars";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef } from "@code-health/parse/source-tree";
import { withNonProductionFolders } from "@code-health/parse/non-production-folders";
import {
  FUNCTION_MEASURES,
  FUNCTION_MEASURE_SUMMARIES,
  FUNCTION_OUTCOME_SUMMARIES,
  MEASURES,
  MEASURE_SUMMARIES,
  OUTCOME_SUMMARIES,
  correlate,
  fileSamples,
  type Correlation,
  type FileSample,
} from "../backtest.ts";
import { readSettings } from "../config.ts";
import { functionSamples } from "../function-backtest.ts";
import { measureTree } from "../measure.ts";

export const name = "backtest";

export const DEFAULT_SAMPLES = 7;
export const MAX_SAMPLES = 60;
export const DEFAULT_MONTHS = 36;
/** A period with fewer files than this for an outcome is left out of that outcome: a rank correlation over a handful of files is noise. A judgement call. */
export const MIN_FILES = 20;

const UNITS = ["file", "function"] as const;
type Unit = (typeof UNITS)[number];

const COMMON_LIMITS = [
  "A change with more files than `history.maxChangesetSize` is left out, as are commits made through the suite's skills.",
  "A fix is a landed change whose text matches `history.fixPatterns`. Some matches are not defects, and a repository that does not name its fixes gives no fix share.",
  "The pooled figures rank each sample within its own period and then take one correlation over every period, so a period with too few samples to count on its own still adds to them. Samples of the same file or function in several periods are not independent, so the pooled sample size overstates the evidence.",
  "Every sample is read with the config of the checkout and the parsers of this version, not those of the time.",
];

const FILE_LIMITS = [
  "A correlation says how well a measure orders the files by what followed. It does not say the measure caused it, and it is not a threshold for any measure.",
  "A larger file is touched by more changes because there is more of it. The partial correlation holds code lines fixed, and is the figure that says whether a measure adds anything to size.",
  "The unit is a file. `--unit function` measures functions instead.",
  "Changes are counted for the files that had a measured function at the sample. A file added after the sample, or read by the lexical layer alone, is not in the period.",
  ...COMMON_LIMITS,
];

const FUNCTION_LIMITS = [
  "A correlation says how well a measure orders the functions by what followed. It does not say the measure caused it, and it is not a threshold for any measure.",
  "A larger function is touched by more changes because there is more of it. The partial correlation holds the function's code lines fixed, and is the figure that says whether a measure adds anything to size.",
  "A landed change counts for a function when its diff against the commit before it on the first-parent line changed a line of the function, so an edit a branch made and undid before it merged is not counted.",
  "A change that deletes a function, or changes it past recognition, is not counted for it, and the function is not followed after it. `ended` in each period counts such functions.",
  "Changes are counted for the top-level production functions the structural layer measured at the sample. A nested function counts in the function that holds it, and a function added after the sample is not in the period.",
  ...COMMON_LIMITS,
];

const MATCHING =
  "A function is followed from each revision of its file to the next on the first-parent line, as `complexity fixes` follows it: by its identity (path and qualified name), then by body similarity of at least complexity.moveSimilarity, and through the file renames git detects. A function created by a change is not counted as fixed by it.";

function wholeNumber(context: CommandContext, option: string, fallback: number, least: number, most: number): number {
  const value = context.values[option];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) < least || Number(value) > most) {
    throw usageError(`--${option} must be a whole number from ${least} to ${most}`);
  }
  return Number(value);
}

function unitOf(context: CommandContext): Unit {
  const value = context.values.unit;
  if (value === undefined) return "file";
  if (typeof value !== "string" || !(UNITS as readonly string[]).includes(value)) throw usageError(`--unit must be one of ${UNITS.join(", ")}`);
  return value as Unit;
}

/** A correlation row as the output names its sample count: `fileSamples` or `functionSamples`. */
function rowsFor<M extends string>(rows: readonly Correlation<M>[], unit: Unit) {
  const key = unit === "file" ? "fileSamples" : "functionSamples";
  return rows.map(({ samples, ...rest }) => ({
    outcome: rest.outcome,
    measure: rest.measure,
    correlation: rest.correlation,
    partialOnCodeLines: rest.partialOnCodeLines,
    [key]: samples,
    periods: rest.periods,
    pooledCorrelation: rest.pooledCorrelation,
    pooledPartialOnCodeLines: rest.pooledPartialOnCodeLines,
    pooledSamples: rest.pooledSamples,
    pooledPeriods: rest.pooledPeriods,
  }));
}

/**
 * The suite's check of its own measures: at revisions sampled over the history, each file's (or each function's) size and
 * complexity, set against what the landed changes of the following period did to it. It prints rank correlations and
 * decides nothing.
 */
export const command: Command = {
  summary: "Whether a file's or a function's size and complexity at past revisions order the files or functions by the changes, lines churned and fixes of the period that followed, with code lines held fixed",
  hidden: true,
  options: { samples: { type: "string" }, months: { type: "string" }, unit: { type: "string" } },
  optionHelp: {
    samples: `how many revisions to sample, 3 to ${MAX_SAMPLES}; each one but the last starts a period that ends at the next (default ${DEFAULT_SAMPLES})`,
    months: `how many months before HEAD's commit date the samples span; more months give longer periods and more changes per period (default ${DEFAULT_MONTHS})`,
    unit: "what each sample is: file, or function, which follows each production function through the history (default file)",
  },
  async run(context) {
    if (context.positionals.length > 0) throw usageError("backtest takes no arguments");
    const wanted = wholeNumber(context, "samples", DEFAULT_SAMPLES, 3, MAX_SAMPLES);
    const months = wholeNumber(context, "months", DEFAULT_MONTHS, 1, 600);
    const unit = unitOf(context);
    const settings = readSettings(context.config);
    const { root, head } = context.repo;
    if ((await readShallowInfo(root)).isShallow) throw usageError("history is shallow, so the periods after each sample cannot be measured");
    await refresh(root, { ref: "HEAD" });
    const history = await analyseHistory(root, { ref: "HEAD", noise: { exclude: [...context.config.effective.exclude], botPatterns: settings.botPatterns, maxChangesetSize: settings.maxChangesetSize, excludeSuiteCommits: true } });
    const line = await firstParentLine(root, head);
    const commits = sampleByTime(line, wanted, monthsBefore(line.at(-1)!.date, months));
    const labels = sampleLabels(commits);

    const changes = [...history.filtered.changes].sort((a, b) => a.committerDate - b.committerDate);
    const groups = groupByLanding(changes.filter((change) => !change.oversized), await readLandings(root, history.view.headSha));
    const cache = await ParseCache.forRepository(root);
    const grammars = new GrammarSet();
    const minChanges = settings.fixes.minRevisions;

    const periodOf = (i: number) => {
      const from = commits[i]!;
      const to = commits[i + 1]!;
      return {
        from: labels[i]!,
        to: labels[i + 1]!,
        revision: from.sha,
        landedChanges: groups.filter(({ landing }) => landing.time > from.date && landing.time <= to.date).length,
        oversizedSkipped: changes.filter((change) => change.oversized && change.committerDate > from.date && change.committerDate <= to.date).length,
      };
    };
    const inputs = { samples: wanted, months, unit, revisions: commits.map((commit) => commit.sha) };
    const extra = { evidence: { grade: history.evidence.grade, logicalChangesInWindow: history.evidence.logicalChangesInWindow, usableHistoryMonths: history.evidence.usableHistoryMonths } };

    if (unit === "function") {
      const counted = new Map(groups.map(({ landing }) => [landing.id, { fix: findFix(settings.fix, landing.id, [landing.text]) !== null }] as const));
      const priorStarts = commits.slice(0, -1).map((from, i) => from.date - (commits[i + 1]!.date - from.date));
      const followed = await functionSamples(root, settings, line, commits, priorStarts, counted, { cache, grammars });
      return withNonProductionFolders(
        {
          inputs,
          extra,
          results: {
            periods: followed.periods.map((period, i) => {
              const { from, to, revision, landedChanges, oversizedSkipped } = periodOf(i);
              return { from, to, revision, files: period.files, functions: period.functions, ended: period.ended, notFollowed: period.notFollowed, landedChanges, oversizedSkipped };
            }),
            matching: MATCHING,
            minFunctions: MIN_FILES,
            minChanges,
            measures: FUNCTION_MEASURE_SUMMARIES,
            outcomes: FUNCTION_OUTCOME_SUMMARIES,
            correlations: rowsFor(correlate(followed.samples, FUNCTION_MEASURES, MIN_FILES, minChanges), unit),
            limits: FUNCTION_LIMITS,
          },
        },
        [...new Set((followed.samples.at(-1) ?? []).map((row) => row.path))],
      );
    }

    // A file is followed through renames by its identity in the history: the identity its path has in the last change at or before the sample.
    const identityAt = new Map<string, string>();
    let seen = 0;
    const periods: (ReturnType<typeof periodOf> & { files: number })[] = [];
    const samples: FileSample[][] = [];
    for (let i = 0; i + 1 < commits.length; i++) {
      const from = commits[i]!;
      const to = commits[i + 1]!;
      for (; seen < changes.length && changes[seen]!.committerDate <= from.date; seen++) for (const file of changes[seen]!.files) identityAt.set(file.path, file.fileId);
      const { files } = await measureTree(await treeFromRef(root, from.sha), { settings, layer: "auto", cache, grammars });
      const rows = fileSamples(files, settings);
      const byIdentity = new Map(rows.map((row) => [identityAt.get(row.path) ?? row.path, row] as const));
      const before = from.date - (to.date - from.date);
      for (const { landing, changes: inLanding } of groups) {
        const after = landing.time > from.date && landing.time <= to.date;
        if (!after && !(landing.time > before && landing.time <= from.date)) continue;
        const churn = new Map<FileSample, number>();
        for (const change of inLanding) {
          for (const file of change.files) {
            const row = byIdentity.get(file.fileId);
            if (row !== undefined) churn.set(row, (churn.get(row) ?? 0) + (file.added ?? 0) + (file.deleted ?? 0));
          }
        }
        const fix = after && findFix(settings.fix, landing.id, [landing.text]) !== null;
        for (const [row, lines] of churn) {
          if (!after) {
            row.priorChanges++;
            continue;
          }
          row.changes++;
          row.linesChurned += lines;
          if (fix) row.fixes++;
        }
      }
      for (const row of rows) row.hotspot = row.indentation * row.priorChanges;
      samples.push(rows);
      const { from: fromLabel, to: toLabel, revision, landedChanges, oversizedSkipped } = periodOf(i);
      periods.push({ from: fromLabel, to: toLabel, revision, files: rows.length, landedChanges, oversizedSkipped });
    }

    return withNonProductionFolders(
      {
        inputs,
        extra,
        results: {
          periods,
          minFiles: MIN_FILES,
          minChanges,
          measures: MEASURE_SUMMARIES,
          outcomes: OUTCOME_SUMMARIES,
          correlations: rowsFor(correlate(samples, MEASURES, MIN_FILES, minChanges), unit),
          limits: FILE_LIMITS,
        },
      },
      (samples.at(-1) ?? []).map((row) => row.path),
    );
  },
};

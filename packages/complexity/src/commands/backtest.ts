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
import { MEASURE_SUMMARIES, OUTCOME_SUMMARIES, correlate, fileSamples, type FileSample } from "../backtest.ts";
import { readSettings } from "../config.ts";
import { measureTree } from "../measure.ts";

export const name = "backtest";

export const DEFAULT_SAMPLES = 7;
export const MAX_SAMPLES = 60;
export const DEFAULT_MONTHS = 36;
/** A period with fewer files than this for an outcome is left out of that outcome: a rank correlation over a handful of files is noise. A judgement call. */
export const MIN_FILES = 20;

const LIMITS = [
  "A correlation says how well a measure orders the files by what followed. It does not say the measure caused it, and it is not a threshold for any measure.",
  "A larger file is touched by more changes because there is more of it. The partial correlation holds code lines fixed, and is the figure that says whether a measure adds anything to size.",
  "The unit is a file. Whether a function's complexity predicts changes to that function is not measured.",
  "Changes are counted for the files that had a measured function at the sample. A file added after the sample, or read by the lexical layer alone, is not in the period.",
  "A change with more files than `history.maxChangesetSize` is left out, as are commits made through the suite's skills.",
  "A fix is a landed change whose text matches `history.fixPatterns`. Some matches are not defects, and a repository that does not name its fixes gives no fix share.",
  "Every sample is read with the config of the checkout and the parsers of this version, not those of the time.",
];

function wholeNumber(context: CommandContext, option: string, fallback: number, least: number, most: number): number {
  const value = context.values[option];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) < least || Number(value) > most) {
    throw usageError(`--${option} must be a whole number from ${least} to ${most}`);
  }
  return Number(value);
}

/**
 * The suite's check of its own measures: at revisions sampled over the history, each file's size and complexity,
 * set against what the landed changes of the following period did to the file. It prints rank correlations and
 * decides nothing.
 */
export const command: Command = {
  summary: "Whether a file's size and complexity at past revisions order the files by the changes, lines churned and fixes of the period that followed, with code lines held fixed",
  hidden: true,
  options: { samples: { type: "string" }, months: { type: "string" } },
  optionHelp: {
    samples: `how many revisions to sample, 3 to ${MAX_SAMPLES}; each one but the last starts a period that ends at the next (default ${DEFAULT_SAMPLES})`,
    months: `how many months before HEAD's commit date the samples span (default ${DEFAULT_MONTHS})`,
  },
  async run(context) {
    if (context.positionals.length > 0) throw usageError("backtest takes no arguments");
    const wanted = wholeNumber(context, "samples", DEFAULT_SAMPLES, 3, MAX_SAMPLES);
    const months = wholeNumber(context, "months", DEFAULT_MONTHS, 1, 600);
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
    // A file is followed through renames by its identity in the history: the identity its path has in the last change at or before the sample.
    const identityAt = new Map<string, string>();
    let seen = 0;

    const periods: { from: string; to: string; revision: string; files: number; landedChanges: number; oversizedSkipped: number }[] = [];
    const samples: FileSample[][] = [];
    for (let i = 0; i + 1 < commits.length; i++) {
      const from = commits[i]!;
      const to = commits[i + 1]!;
      for (; seen < changes.length && changes[seen]!.committerDate <= from.date; seen++) for (const file of changes[seen]!.files) identityAt.set(file.path, file.fileId);
      const { files } = await measureTree(await treeFromRef(root, from.sha), { settings, layer: "auto", cache, grammars });
      const rows = fileSamples(files, settings);
      const byIdentity = new Map(rows.map((row) => [identityAt.get(row.path) ?? row.path, row] as const));
      const before = from.date - (to.date - from.date);
      let landed = 0;
      for (const { landing, changes: inLanding } of groups) {
        const after = landing.time > from.date && landing.time <= to.date;
        if (!after && !(landing.time > before && landing.time <= from.date)) continue;
        if (after) landed++;
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
      periods.push({
        from: labels[i]!,
        to: labels[i + 1]!,
        revision: from.sha,
        files: rows.length,
        landedChanges: landed,
        oversizedSkipped: changes.filter((change) => change.oversized && change.committerDate > from.date && change.committerDate <= to.date).length,
      });
    }

    const minChanges = settings.fixes.minRevisions;
    return {
      inputs: { samples: wanted, months, revisions: commits.map((commit) => commit.sha) },
      extra: { evidence: { grade: history.evidence.grade, logicalChangesInWindow: history.evidence.logicalChangesInWindow, usableHistoryMonths: history.evidence.usableHistoryMonths } },
      results: {
        periods,
        minFiles: MIN_FILES,
        minChanges,
        measures: MEASURE_SUMMARIES,
        outcomes: OUTCOME_SUMMARIES,
        correlations: correlate(samples, MIN_FILES, minChanges),
        limits: LIMITS,
      },
    };
  },
};

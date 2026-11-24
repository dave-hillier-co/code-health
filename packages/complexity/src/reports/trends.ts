import { usageError } from "@code-health/cli-kit/errors";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { commonRoot, foldersBelow } from "@code-health/graph/folders";
import { monthsBefore } from "@code-health/history/evidence";
import { firstParentLine, sampleByTime, sampleLabels } from "@code-health/history/trend-samples";
import { GrammarSet } from "@code-health/parse/grammars";
import { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef } from "@code-health/parse/source-tree";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import { readTrend } from "@code-health/report/components/trend-grid";
import type { Trend } from "@code-health/report/components/trend-marker";
import type { Slot } from "@code-health/report/protocol";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import { formatNumber } from "@code-health/report/text";
import { readSettings } from "../config.ts";
import { folderMeasures, meanInterfaceDepth, splitCheck, type FolderMeasures } from "../folder-measures.ts";
import { measureTree } from "../measure.ts";

export const DEFAULT_SAMPLES = 12;
export const MAX_SAMPLES = 60;
/**
 * Guideline for calling a change "more concentrated", "less concentrated", "rose" or "fell": the last value
 * differs from the first by more than this fraction of it. It labels the direction; both values are always
 * printed. A judgement call.
 */
export const TREND_TOLERANCE = 0.05;
/** How many levels of folders below the common root are listed. */
const LEVELS = 2;
const CHART_FOLDERS = 6;
const GRID_FOLDERS = 12;
const BAR_FOLDERS = 15;
const TABLE_FOLDERS = 40;

const WORDING: Record<Trend, string> = { stronger: "more concentrated", stable: "no clear change", weaker: "less concentrated" };
const VERDICTS = ["less-concentrated", "no-clear-change", "more-concentrated"];
const ROOT_TEXT = "the repository (/)";
const SHARE = "percent of weighted complexity in functions above the guideline";
const folderText = (folder: string) => (folder === "" ? ROOT_TEXT : folder);
const round = (value: number | null, places = 2) => (value === null ? null : Number(value.toFixed(places)));
const valueText = (value: number | null) => (value === null ? "none" : formatNumber(value));
const firstAndLast = (first: number | null, last: number | null) => `${valueText(first)} at the first sample, ${valueText(last)} at the last`;

interface Sample {
  sha: string;
  label: string;
  folders: Map<string, FolderMeasures>;
  /** Mean interface depth of the production code, for the check on split functions. */
  depth: number | null;
}

function samplesOption(context: CommandContext): number {
  const value = context.values.samples;
  if (value === undefined) return DEFAULT_SAMPLES;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) < 2 || Number(value) > MAX_SAMPLES) {
    throw usageError(`--samples must be a whole number from 2 to ${MAX_SAMPLES}`);
  }
  return Number(value);
}

type Measure = (measures: FolderMeasures) => number | null;
const meanOf: Measure = (m) => round(m.meanCyclomatic);
const maxOf: Measure = (m) => m.maxCyclomatic;
const shareOf: Measure = (m) => (m.shareAbove === null ? null : round(m.shareAbove * 100, 1));
const seriesOf = (samples: readonly Sample[], folder: string, value: Measure) => samples.map((sample) => (sample.folders.has(folder) ? value(sample.folders.get(folder)!) : null));

/** The values as a percent of the first one that is above 0, so series of different sizes share one axis. */
function indexed(values: readonly (number | null)[]): (number | null)[] {
  const base = values.find((v) => v !== null && v > 0);
  return values.map((v) => (v === null || base === undefined || base === null ? null : round((v / base) * 100, 1)));
}

function slotsFor(folders: readonly string[]): Slot[] {
  const about = { kind: "report" as const, ref: "trends", label: "the size and complexity trend" };
  return [
    {
      id: "trend",
      title: "Judgement: the trend",
      about,
      task: "Say whether complexity is collecting in functions above the guideline or spreading out over the samples. Cite the percent of weighted complexity in functions above the guideline at the first and last sample, and say whether total cyclomatic complexity grew faster than code lines. Say so when the samples are few, the span is short, or the change is within the tolerance. This is a leading indicator: do not write that changes got cheaper or dearer.",
      verdicts: VERDICTS,
      maxChars: 600,
    },
    ...(folders.length === 0
      ? []
      : [
          {
            id: "folders",
            title: "Judgement: folders to look at",
            about,
            task: "Choose the folders whose change in size or complexity most deserves a look, and say for each what the figures show and what to check next (for example `complexity analyse <folder>`). A folder that grew because code was added to it, with its mean and its percent above the guideline steady, is expected growth, not a problem.",
            verdicts: ["look", "expected-growth"],
            maxChars: 300,
            choose: { max: 3, candidates: folders.map((folder) => ({ ref: folder, label: folder })) },
          } satisfies Slot,
        ]),
  ];
}

export const trendsReport: ReportKind = {
  summary: "Size and cyclomatic complexity over time: code lines, mean and largest complexity, and how much of the complexity sits in functions above the guideline, for the repository and its folders at revisions sampled along the first-parent line",
  options: { samples: { type: "string" } },
  optionHelp: { samples: `trends: how many revisions to sample, 2 to ${MAX_SAMPLES} (default ${DEFAULT_SAMPLES})` },
  async build(context: CommandContext): Promise<ReportBuild> {
    if (context.positionals.length > 0) throw usageError("report trends takes no arguments");
    const settings = readSettings(context.config);
    const wanted = samplesOption(context);
    const { root, head } = context.repo;
    const line = await firstParentLine(root, head);
    const headDate = line.at(-1)!.date;
    const commits = sampleByTime(line, wanted, monthsBefore(headDate, settings.windowMonths));
    const allLabels = sampleLabels(commits);
    const cache = await ParseCache.forRepository(root);
    const grammars = new GrammarSet();
    const measured: Sample[] = [];
    for (const [i, commit] of commits.entries()) {
      // Every revision is read with the config of the checkout. The parse cache keys by file content, so a file that did not change between two samples is parsed once.
      const { files } = await measureTree(await treeFromRef(root, commit.sha), { settings, layer: "auto", cache, grammars });
      measured.push({ sha: commit.sha, label: allLabels[i]!, folders: folderMeasures(files, settings), depth: meanInterfaceDepth(files, settings) });
    }
    // A revision from before the first production code file has no figure to start a trend from. The last sample is kept whatever it holds.
    const start = Math.min(Math.max(0, measured.findIndex((sample) => sample.folders.get("")!.files > 0)), measured.length - 1);
    const samples = measured.slice(start);
    const labels = allLabels.slice(start);

    const first = samples[0]!;
    const last = samples.at(-1)!;
    const repoFirst = first.folders.get("")!;
    const repoLast = last.folders.get("")!;
    const top = commonRoot(last.folders);
    const listed = foldersBelow(last.folders, top, LEVELS);
    const bySize = (a: string, b: string) => last.folders.get(b)!.codeLines - last.folders.get(a)!.codeLines || (a < b ? -1 : 1);
    const withFunctions = (folder: string) => last.folders.get(folder)!.functions > 0;
    const children = foldersBelow(last.folders, top, 1).filter(withFunctions).sort(bySize);
    const grid = listed.filter(withFunctions).sort(bySize).slice(0, GRID_FOLDERS);
    const linesAt = (sample: Sample, folder: string) => sample.folders.get(folder)?.codeLines ?? 0;
    const changed = listed
      .map((folder) => ({ folder, from: linesAt(first, folder), to: linesAt(last, folder) }))
      .filter((row) => row.from !== row.to)
      .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || (a.folder < b.folder ? -1 : 1));

    const repoShare = seriesOf(samples, "", shareOf);
    const reading = readTrend(labels, repoShare, TREND_TOLERANCE);
    const tableFolders = ["", ...(top === "" ? [] : [top]), ...listed];
    const rows = tableFolders.map((folder): Record<string, Cell> => {
      const own = readTrend(labels, seriesOf(samples, folder, shareOf), TREND_TOLERANCE);
      const mean = readTrend(labels, seriesOf(samples, folder, meanOf), TREND_TOLERANCE);
      const now = last.folders.get(folder)!;
      return {
        folder: folderText(folder),
        files: now.files,
        linesFirst: first.folders.get(folder)?.codeLines ?? null,
        linesLast: now.codeLines,
        functions: now.functions,
        meanFirst: mean.first?.value ?? null,
        meanLast: meanOf(now),
        maxLast: now.maxCyclomatic,
        above: now.aboveGuideline,
        shareFirst: own.first?.value ?? null,
        shareLast: shareOf(now),
        trend: own.first === null ? "no functions" : own.trend === null ? `first seen ${own.first.label}` : WORDING[own.trend],
      };
    });
    const split = splitCheck({ measures: repoFirst, depth: first.depth }, { measures: repoLast, depth: last.depth });
    const enough = samples.length >= 2;
    const where = top === "" ? "the repository root" : `\`${top}\`, the deepest folder that holds every production code file`;
    const guideline = settings.guidelines.cyclomatic.warn;
    const shareNote = `A function's weight is its cyclomatic complexity times the square root of its code lines. The percent is the weight of the functions above the cyclomatic guideline (${guideline}, or the override for their path) out of the weight of all functions: 0 means no function is above it, 100 means every function is.`;

    const sections: Section[] = [
      {
        id: "repository",
        heading: "Repository",
        blocks: [
          { type: "judgement", slot: "trend" },
          ...(enough ? [] : [{ type: "notice", level: "limit", text: `Only ${samples.length} revision was sampled, so there is no trend: the first-parent line has one commit in the window` } satisfies Block]),
          {
            type: "facts",
            caption: "Size and cyclomatic complexity of the production code at the first and last sample",
            facts: [
              { label: "Samples", value: `${samples.length}, from ${first.label} to ${last.label}` },
              { label: "Code lines", value: firstAndLast(repoFirst.codeLines, repoLast.codeLines) },
              { label: "Production code files", value: firstAndLast(repoFirst.files, repoLast.files) },
              { label: "Functions measured", value: firstAndLast(repoFirst.functions, repoLast.functions) },
              { label: "Mean cyclomatic complexity", value: firstAndLast(meanOf(repoFirst), meanOf(repoLast)) },
              { label: "Largest cyclomatic complexity", value: firstAndLast(repoFirst.maxCyclomatic, repoLast.maxCyclomatic) },
              { label: `Functions above the guideline (${guideline})`, value: firstAndLast(repoFirst.aboveGuideline, repoLast.aboveGuideline) },
              { label: "Percent of weighted complexity in them", value: firstAndLast(shareOf(repoFirst), shareOf(repoLast)) },
            ],
          },
          ...(reading.first === null || reading.last === null || reading.trend === null
            ? []
            : [{ type: "trend-marker", label: SHARE, earlier: reading.first.value, later: reading.last.value, windows: [reading.first.label, reading.last.label], tolerance: TREND_TOLERANCE, wording: WORDING } satisfies Block]),
          {
            type: "trend-chart",
            title: "Growth of complexity against code lines and functions",
            unit: "percent of the first sample",
            labels,
            series: [
              { name: "total cyclomatic complexity", values: indexed(seriesOf(samples, "", (m) => m.cyclomatic)) },
              { name: "code lines", values: indexed(seriesOf(samples, "", (m) => m.codeLines)) },
              { name: "functions", values: indexed(seriesOf(samples, "", (m) => m.functions)) },
            ],
            note: "Each line is a percent of its own first value above 0. Total cyclomatic complexity above the code lines line means the code gained branches faster than it gained lines.",
          },
          { type: "trend-chart", title: "Weighted complexity in functions above the guideline, for the repository", unit: SHARE, labels, series: [{ name: "repository", values: repoShare }], note: shareNote },
          { type: "trend-chart", title: "Mean cyclomatic complexity of the repository", unit: "mean cyclomatic complexity per function", labels, series: [{ name: "repository", values: seriesOf(samples, "", meanOf) }], note: "Total cyclomatic complexity divided by the number of functions measured. The mean falls when simple functions are added, whether or not any complex function changed." },
          { type: "trend-chart", title: "Largest cyclomatic complexity of one function", unit: "cyclomatic complexity", labels, series: [{ name: "repository", values: seriesOf(samples, "", maxOf) }], note: "The value of the most complex function at each sample, which is not always the same function." },
        ],
      },
      {
        id: "folders",
        heading: "Folders",
        blocks: [
          { type: "paragraph", text: `Folders are those of the last sample, listed ${LEVELS} levels below ${where}. A folder's figures cover every production code file under it, its subfolders included, so the counts of the folders at one level add up to those of the folder that holds them.` },
          { type: "trend-chart", title: "Weighted complexity in functions above the guideline, for the largest folders", unit: SHARE, labels, series: children.slice(0, CHART_FOLDERS).map((folder) => ({ name: folder, values: seriesOf(samples, folder, shareOf) })), emptyText: "Weighted complexity in functions above the guideline, for the largest folders: there are fewer than two samples, or no folder below the common root has a measured function.", ...(children.length > CHART_FOLDERS ? { note: `The ${CHART_FOLDERS} folders one level down with the most code lines at the last sample are drawn, of ${children.length}.` } : {}) },
          { type: "trend-grid", title: "Folders by weighted complexity in functions above the guideline", unit: SHARE, labels, items: grid.map((folder) => ({ name: folder, values: seriesOf(samples, folder, shareOf) })), tolerance: TREND_TOLERANCE, wording: WORDING, note: `The ${GRID_FOLDERS} folders with the most code lines at the last sample are drawn, most code lines first. A folder with no line before a sample did not exist then, or had no measured function.`, emptyText: "Folders by weighted complexity in functions above the guideline: there are fewer than two samples, or no folder below the common root has a measured function." },
          { type: "change-bars", title: "Change in code lines by folder", unit: "code lines", samples: [first.label, last.label], bars: changed.slice(0, BAR_FOLDERS).map((row) => ({ label: row.folder, from: row.from, to: row.to })), wording: { rise: "more code", fall: "less code" }, note: `${changed.length > BAR_FOLDERS ? `The ${BAR_FOLDERS} largest changes are drawn, of ${changed.length}. ` : ""}A folder nested in another is counted in both bars.`, emptyText: "Change in code lines by folder: no folder's code lines differ between the first and last sample." },
          ...(grid.length === 0 ? [] : [{ type: "judgement", slot: "folders" } satisfies Block]),
          {
            type: "ranked-table",
            caption: "Folders, each after the folder that holds it",
            numbered: false,
            noun: "folders",
            total: rows.length,
            columns: [
              { key: "folder", label: "Folder" },
              { key: "files", label: "Files", align: "right" },
              { key: "linesFirst", label: `Code lines, ${first.label}`, align: "right" },
              { key: "linesLast", label: `Code lines, ${last.label}`, align: "right" },
              { key: "functions", label: "Functions", align: "right" },
              { key: "meanFirst", label: "Mean cyclomatic, first value", align: "right" },
              { key: "meanLast", label: `Mean cyclomatic, ${last.label}`, align: "right" },
              { key: "maxLast", label: `Largest cyclomatic, ${last.label}`, align: "right" },
              { key: "above", label: "Functions above the guideline", align: "right" },
              { key: "shareFirst", label: "Percent above, first value", align: "right" },
              { key: "shareLast", label: `Percent above, ${last.label}`, align: "right" },
              { key: "trend", label: "Trend of percent above" },
            ],
            rows: rows.slice(0, TABLE_FOLDERS),
          },
        ],
      },
      {
        id: "gaming",
        heading: "Gaming check",
        blocks: [
          { type: "paragraph", text: "Mean cyclomatic complexity and the percent above the guideline fall when functions are split into small helpers that each do little, without the code getting easier to follow. These two figures show that: the number of functions, and mean interface depth, which is how much an exported function or class does per element of its interface." },
          ...(split.flagged ? [{ type: "notice", level: "warning", text: `Between the first and last sample, ${split.reasons.join("; ")}` } satisfies Block] : []),
          { type: "sparkline", title: "Functions measured", unit: "functions", points: samples.map((sample) => ({ label: sample.label, value: sample.folders.get("")!.functions })) },
          { type: "sparkline", title: "Mean interface depth", unit: "mean interface depth", points: samples.flatMap((sample) => (sample.depth === null ? [] : [{ label: sample.label, value: round(sample.depth)! }])) },
        ],
      },
    ];

    return {
      title: "Size and complexity trends",
      inputs: { samples: wanted, revisions: samples.map((sample) => sample.sha) },
      header: {
        evidenceGrade: "not applicable",
        historyWindow: `${samples.length} of ${line.length} commits on the first-parent line were sampled, evenly over time from ${first.label} to ${last.label}, within the ${settings.windowMonths} months before HEAD's commit date.`,
        excluded: start === 0 ? [] : [{ what: "sampled revisions from before the first production code file", count: start }],
      },
      sections,
      limits: [
        "This is a leading indicator. It shows the size and shape of the code at each sample and says nothing about whether changes cost less or more: `complexity outcome` measures that.",
        "These are the measures the SlopCodeBench paper set against the cost of an agent's next change. Code lines had the strongest link there, the largest and mean cyclomatic complexity a weaker one, and the weighted percent above a cutoff the weakest. That was measured on small programs written by one agent, not on this repository.",
        `More concentrated, less concentrated and no clear change are labels from a guideline: the last value differs from the first by more than ${formatNumber(TREND_TOLERANCE * 100)} percent of it. The guideline labels the change and decides nothing.`,
        "The function figures cover the functions a grammar measured, with a nested function counted in the function that holds it. A file read by the lexical layer alone adds its code lines and no function. Test code is left out.",
        "Every sample is read with the config of the checkout (excludes, test patterns, guidelines) and the parsers of this version, not those of the time.",
        "Folders are named by their path at the last sample. A folder that was renamed has no values before its rename, and its earlier figures are under its old path, which is not listed.",
        "Code lines and total cyclomatic complexity grow whenever code is added. The mean, and the total set against code lines, are the figures that say whether the code added was more complex than the code already there.",
        "The samples are points in time. What happened between two samples is not shown, and a short span or few commits gives few samples.",
      ],
      slots: slotsFor(grid),
    };
  },
};

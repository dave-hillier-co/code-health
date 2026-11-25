import { usageError } from "@code-health/cli-kit/errors";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { commonRoot, foldersBelow } from "@code-health/graph/folders";
import { monthsBefore } from "@code-health/history/evidence";
import { firstParentLine, sampleByTime, sampleLabels } from "@code-health/history/trend-samples";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import { readTrend } from "@code-health/report/components/trend-grid";
import type { Trend } from "@code-health/report/components/trend-marker";
import type { Slot } from "@code-health/report/protocol";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import { formatNumber } from "@code-health/report/text";
import { revisionEdges } from "../change-distance.ts";
import { readSettings, type LocalitySettings } from "../config.ts";
import { folderFigures, type FolderFigures } from "../folder-trends.ts";
import { buildModel } from "../model.ts";
import { loadProject } from "../project.ts";
import { gamingCheck, structureMetricsOf, type StructureMetrics } from "../structure-metrics.ts";

export const DEFAULT_SAMPLES = 12;
export const MAX_SAMPLES = 60;
/**
 * Guideline for calling a change in mean distance per use "closer" or "further apart": the last value differs
 * from the first by more than this fraction of it. It labels the direction; both values are always printed. A
 * judgement call.
 */
export const TREND_TOLERANCE = 0.05;
/** How many levels of folders below the common root are listed. */
const LEVELS = 2;
const CHART_FOLDERS = 6;
const GRID_FOLDERS = 12;
const BAR_FOLDERS = 15;
const TABLE_FOLDERS = 40;

const WORDING: Record<Trend, string> = { stronger: "further apart", stable: "no clear change", weaker: "closer" };
const VERDICTS = ["closer", "no-clear-change", "further-apart"];
const ROOT_TEXT = "the repository (/)";
const folderText = (folder: string) => (folder === "" ? ROOT_TEXT : folder);
const round = (value: number | null) => (value === null ? null : Number(value.toFixed(3)));
const valueText = (value: number | null) => (value === null ? "none" : formatNumber(value));

interface Sample {
  sha: string;
  label: string;
  folders: Map<string, FolderFigures>;
  structure: StructureMetrics;
}

function samplesOption(context: CommandContext): number {
  const value = context.values.samples;
  if (value === undefined) return DEFAULT_SAMPLES;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) < 2 || Number(value) > MAX_SAMPLES) {
    throw usageError(`--samples must be a whole number from 2 to ${MAX_SAMPLES}`);
  }
  return Number(value);
}

/** One revision, read with the config of the checkout and without history, so an edge weighs its uses alone. */
async function measure(root: string, sha: string, label: string, settings: LocalitySettings): Promise<Sample> {
  const project = await loadProject(root, sha, settings);
  const model = buildModel(project, settings);
  return { sha, label, folders: folderFigures(project.production, revisionEdges(model)), structure: structureMetricsOf(project, model) };
}

const seriesOf = (samples: readonly Sample[], folder: string, value: (figures: FolderFigures) => number | null) => samples.map((sample) => round(sample.folders.has(folder) ? value(sample.folders.get(folder)!) : null));
const meanOf = (figures: FolderFigures) => figures.meanDistancePerUse;
const totalOf = (figures: FolderFigures) => figures.totalUseDistance;

/** The values as a percent of the first one that is above 0, so series of different sizes share one axis. */
function indexed(values: readonly (number | null)[]): (number | null)[] {
  const base = values.find((v) => v !== null && v > 0);
  return values.map((v) => (v === null || base === undefined || base === null ? null : round((v / base) * 100)));
}

function slotsFor(folders: readonly string[]): Slot[] {
  const about = { kind: "report" as const, ref: "trends", label: "the import distance trend" };
  return [
    {
      id: "trend",
      title: "Judgement: the trend",
      about,
      task: "Say whether code is moving closer to its uses or further apart over the samples. Cite the mean distance per use at the first and last sample, and say whether total import distance grew faster than the number of uses. Say so when the samples are few, the span is short, or the change is within the tolerance. This is a leading indicator: do not write that changes got cheaper or dearer.",
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
            task: "Choose the folders whose change in import distance most deserves a look, and say for each what the figures show and what to check next (for example `locality analyse <folder>`). A folder that grew because code was added to it is expected growth, not a problem.",
            verdicts: ["look", "expected-growth"],
            maxChars: 300,
            choose: { max: 3, candidates: folders.map((folder) => ({ ref: folder, label: folder })) },
          } satisfies Slot,
        ]),
  ];
}

export const trendsReport: ReportKind = {
  summary: "Import distance over time: the repository and its folders at revisions sampled along the first-parent line, with charts of whether code is moving closer to its uses or further apart",
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
    const measured: Sample[] = [];
    for (const [i, commit] of commits.entries()) measured.push(await measure(root, commit.sha, allLabels[i]!, settings));
    // A revision from before the first production file has no figure to start a trend from. The last sample is kept whatever it holds.
    const start = Math.min(Math.max(0, measured.findIndex((sample) => sample.folders.get("")!.files > 0)), measured.length - 1);
    const samples = measured.slice(start);
    const labels = allLabels.slice(start);

    const first = samples[0]!;
    const last = samples.at(-1)!;
    const repoFirst = first.folders.get("")!;
    const repoLast = last.folders.get("")!;
    const top = commonRoot(last.folders);
    const listed = foldersBelow(last.folders, top, LEVELS);
    const byUses = (a: string, b: string) => last.folders.get(b)!.uses - last.folders.get(a)!.uses || (a < b ? -1 : 1);
    const children = foldersBelow(last.folders, top, 1).filter((folder) => last.folders.get(folder)!.uses > 0).sort(byUses);
    const grid = listed.filter((folder) => last.folders.get(folder)!.uses > 0).sort(byUses).slice(0, GRID_FOLDERS);
    const totalAt = (sample: Sample, folder: string) => sample.folders.get(folder)?.totalUseDistance ?? 0;
    const changed = listed
      .map((folder) => ({ folder, from: totalAt(first, folder), to: totalAt(last, folder) }))
      .filter((row) => row.from !== row.to)
      .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || (a.folder < b.folder ? -1 : 1));

    const repoMean = seriesOf(samples, "", meanOf);
    const reading = readTrend(labels, repoMean, TREND_TOLERANCE);
    const tableFolders = ["", ...(top === "" ? [] : [top]), ...listed];
    const rows = tableFolders.map((folder): Record<string, Cell> => {
      const mean = seriesOf(samples, folder, meanOf);
      const own = readTrend(labels, mean, TREND_TOLERANCE);
      const now = last.folders.get(folder)!;
      return {
        folder: folderText(folder),
        files: now.files,
        uses: now.uses,
        totalFirst: first.folders.get(folder)?.totalUseDistance ?? null,
        totalLast: now.totalUseDistance,
        meanFirst: own.first?.value ?? null,
        meanLast: round(now.meanDistancePerUse),
        trend: own.first === null ? "no uses" : own.trend === null ? `first seen ${own.first.label}` : WORDING[own.trend],
      };
    });
    const gaming = gamingCheck(first.structure, last.structure);
    const enough = samples.length >= 2;
    const where = top === "" ? "the repository root" : `\`${top}\`, the deepest folder that holds every production file`;

    const sections: Section[] = [
      {
        id: "repository",
        heading: "Repository",
        blocks: [
          { type: "judgement", slot: "trend" },
          ...(enough ? [] : [{ type: "notice", level: "limit", text: `Only ${samples.length} revision was sampled, so there is no trend: the first-parent line has one commit in the window` } satisfies Block]),
          {
            type: "facts",
            caption: "Import distance of the repository at the first and last sample",
            facts: [
              { label: "Samples", value: `${samples.length}, from ${first.label} to ${last.label}` },
              { label: "Mean distance per use", value: `${valueText(round(repoFirst.meanDistancePerUse))} at the first sample, ${valueText(round(repoLast.meanDistancePerUse))} at the last` },
              { label: "Total import distance", value: `${formatNumber(repoFirst.totalUseDistance)} at the first sample, ${formatNumber(repoLast.totalUseDistance)} at the last` },
              { label: "Uses", value: `${formatNumber(repoFirst.uses)} at the first sample, ${formatNumber(repoLast.uses)} at the last` },
              { label: "Production files", value: `${formatNumber(repoFirst.files)} at the first sample, ${formatNumber(repoLast.files)} at the last` },
            ],
          },
          ...(reading.first === null || reading.last === null || reading.trend === null
            ? []
            : [{ type: "trend-marker", label: "mean distance per use", earlier: reading.first.value, later: reading.last.value, windows: [reading.first.label, reading.last.label], tolerance: TREND_TOLERANCE, wording: WORDING } satisfies Block]),
          { type: "trend-chart", title: "Mean distance per use of the repository", unit: "mean distance per use", labels, series: [{ name: "repository", values: repoMean }], note: "Mean distance per use is total import distance divided by the number of uses: how many folder hops lie between a use and what it uses, on average. Lower is closer." },
          {
            type: "trend-chart",
            title: "Growth of import distance against uses and files",
            unit: "percent of the first sample",
            labels,
            series: [
              { name: "total import distance", values: indexed(seriesOf(samples, "", totalOf)) },
              { name: "uses", values: indexed(seriesOf(samples, "", (figures) => figures.uses)) },
              { name: "production files", values: indexed(seriesOf(samples, "", (figures) => figures.files)) },
            ],
            note: "Each line is a percent of its own first value above 0. Total import distance above the uses line means distance grew faster than the number of uses, so uses are further apart on average.",
          },
        ],
      },
      {
        id: "folders",
        heading: "Folders",
        blocks: [
          { type: "paragraph", text: `Folders are those of the last sample, listed ${LEVELS} levels below ${where}. A folder's figures cover every file under it, its subfolders included, so the figures of the folders at one level add up to those of the folder that holds them.` },
          { type: "trend-chart", title: "Mean distance per use of the largest folders", unit: "mean distance per use", labels, series: children.slice(0, CHART_FOLDERS).map((folder) => ({ name: folder, values: seriesOf(samples, folder, meanOf) })), emptyText: "Mean distance per use of the largest folders: there are fewer than two samples, or no folder below the common root has a use." , ...(children.length > CHART_FOLDERS ? { note: `The ${CHART_FOLDERS} folders one level down with the most uses at the last sample are drawn, of ${children.length}.` } : {}) },
          { type: "trend-grid", title: "Folders by mean distance per use", unit: "mean distance per use", labels, items: grid.map((folder) => ({ name: folder, values: seriesOf(samples, folder, meanOf) })), tolerance: TREND_TOLERANCE, wording: WORDING, note: `The ${GRID_FOLDERS} folders with the most uses at the last sample are drawn, most uses first. A folder with no line before a sample did not exist then, or had no use.`, emptyText: "Folders by mean distance per use: there are fewer than two samples, or no folder below the common root has a use." },
          { type: "change-bars", title: "Change in total import distance by folder", unit: "total import distance", samples: [first.label, last.label], bars: changed.slice(0, BAR_FOLDERS).map((row) => ({ label: row.folder, from: row.from, to: row.to })), wording: { rise: "more distance", fall: "less distance" }, note: `${changed.length > BAR_FOLDERS ? `The ${BAR_FOLDERS} largest changes are drawn, of ${changed.length}. ` : ""}A folder's total rises when code is added to it, so read the bar beside the folder's mean distance per use. A folder nested in another is counted in both bars.`, emptyText: "Change in total import distance by folder: no folder's total differs between the first and last sample." },
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
              { key: "uses", label: "Uses", align: "right" },
              { key: "totalFirst", label: `Total distance, ${first.label}`, align: "right" },
              { key: "totalLast", label: `Total distance, ${last.label}`, align: "right" },
              { key: "meanFirst", label: "Mean per use, first value", align: "right" },
              { key: "meanLast", label: `Mean per use, ${last.label}`, align: "right" },
              { key: "trend", label: "Trend of mean per use" },
            ],
            rows: rows.slice(0, TABLE_FOLDERS),
          },
        ],
      },
      {
        id: "gaming",
        heading: "Gaming check",
        blocks: [
          { type: "paragraph", text: "Import distance can fall because files were buried in new folders, not because code moved beside its uses. These two figures show that: the number of folders that hold a single production file, and the depth of the deepest folder that holds one." },
          ...(gaming.flagged ? [{ type: "notice", level: "warning", text: `Between the first and last sample, ${gaming.reasons.join("; ")}` } satisfies Block] : []),
          { type: "sparkline", title: "Folders holding a single production file", unit: "single-file folders", points: samples.map((sample) => ({ label: sample.label, value: sample.structure.singleFileFolders })) },
          { type: "sparkline", title: "Maximum folder depth", unit: "folder depth", points: samples.map((sample) => ({ label: sample.label, value: sample.structure.maxDepth })) },
        ],
      },
    ];

    return {
      title: "Import distance trends",
      inputs: { samples: wanted, revisions: samples.map((sample) => sample.sha) },
      header: {
        evidenceGrade: "not applicable",
        historyWindow: `${samples.length} of ${line.length} commits on the first-parent line were sampled, evenly over time from ${first.label} to ${last.label}, within the ${settings.windowMonths} months before HEAD's commit date.`,
        excluded: start === 0 ? [] : [{ what: "sampled revisions from before the first production file", count: start }],
      },
      sections,
      limits: [
        "This is a leading indicator. It shows where code sits against its uses at each sample and says nothing about whether changes cost less or more: `locality measure compare` measures that.",
        `Closer, further apart and no clear change are labels from a guideline: the last mean distance per use differs from the first by more than ${formatNumber(TREND_TOLERANCE * 100)} percent of it. The guideline labels the change and decides nothing.`,
        "An edge weighs its use count alone, without the co-change weighting that `locality analyse` adds, so the totals here are equal to `metrics.totalWeightedDistance` of `analyse` only with `locality.useHistory` off.",
        "Every sample is read with the config of the checkout (entry points, excludes) and the parsers of this version, not those of the time.",
        "Folders are named by their path at the last sample. A folder that was renamed has no values before its rename, and its earlier figures are under its old path, which is not listed.",
        "Total import distance grows whenever code is added. Mean distance per use, and total distance set against the number of uses, are the figures that say where the code was placed.",
        "The samples are points in time. What happened between two samples is not shown, and a short span or few commits gives few samples.",
      ],
      slots: slotsFor(grid),
    };
  },
};

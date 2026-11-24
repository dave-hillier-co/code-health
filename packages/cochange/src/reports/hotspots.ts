import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { usageError } from "@code-health/cli-kit/errors";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { excludedCounts, historyWindowText, isoDate } from "@code-health/history/report-header";
import type { Evidence } from "@code-health/history/evidence";
import type { FiltersApplied } from "@code-health/history/noise";
import { noCacheOption } from "@code-health/history/results-cache";
import { readBlobAt } from "@code-health/history/tree";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import { dropEmptySlots } from "@code-health/report/empty-block";
import { capRows } from "@code-health/report/table-cap";
import { codeSpan } from "@code-health/report/text";
import { reportPath } from "@code-health/history/reports";
import { statSync } from "node:fs";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import { FLAG_VERDICTS, xrayBlocks, type XrayData, type XrayFunction } from "@code-health/report/xray";
import { command as hotspotsCommand } from "../commands/hotspots.ts";
import { command as trendCommand, TREND_GUIDELINE } from "../commands/trend.ts";
import { readSettings } from "../config.ts";
import { orderedHotspots, type HotspotRow } from "../hotspot-ranking.ts";
import { readSiblingResult, type SiblingResult } from "../sibling-reports.ts";
import { windowOptions } from "../window-options.ts";

/** Files in the friction list unless `--top` says otherwise. */
export const DEFAULT_FRICTION = 20;
/** Friction files whose history is drawn. */
const TREND_FILES = 5;
/** Friction files that get an X-Ray section. */
const XRAY_FILES = 3;
/** Functions each X-Ray section lists. */
const XRAY_ROWS = 8;
/** Files in the treemap data. The treemap draws the largest of them and counts the rest. */
const MAP_FILES = 20;
const TREND_SAMPLES = 10;
/** Friction files whose history is drawn as a sparkline; the history table lists all `TREND_FILES`. */
const SPARKLINES = 1;
const RECOMMENDATIONS = ["refactor", "split", "leave", "review", "dismiss"];

const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const percentOf = (share: number) => Math.round(share * 1000) / 10;
const byScore = (a: HotspotRow, b: HotspotRow) => (b.score ?? -1) - (a.score ?? -1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A file of the friction list: change frequency is at or above the guideline percentile, and the file is complex. */
interface Friction {
  row: HotspotRow;
  frequencyPercentile: number;
  complexityPercentile: number | null;
  /** Functions of the file above the cognitive guideline, or null when no function-level result was read. */
  functionsAbove: number | null;
}

/** How a file counts as complex: it has a function above the cognitive guideline, or its complexity percentile is at the guideline. */
type ComplexityBasis = "functions" | "percentile";

/**
 * The functions of each file above the cognitive guideline, from the stored `complexity analyse` result: a
 * function labelled `cognitive-warn` or `cognitive-high`. Undefined when the result is absent.
 */
function cognitiveAbove(analyse: SiblingResult | undefined): Map<string, number> | undefined {
  if (analyse === undefined) return undefined;
  const above = new Map<string, number>();
  for (const row of analyse.rows) {
    if (typeof row.path !== "string" || !Array.isArray(row.labels)) continue;
    if (row.labels.some((label) => label === "cognitive-warn" || label === "cognitive-high")) above.set(row.path, (above.get(row.path) ?? 0) + 1);
  }
  return above;
}

/**
 * The friction list. Change frequency is a percentile among all the files. With the stored `complexity analyse`
 * result a file is complex when it has a function above the cognitive guideline, which is how CodeScene derives
 * file health from function-level code smells. Without it a file is complex when its complexity percentile, among
 * the files that have a complexity, is at or above the same guideline percentile as frequency.
 */
function frictionOf(rows: readonly HotspotRow[], percentile: number, above: ReadonlyMap<string, number> | undefined): { all: Friction[]; basis: ComplexityBasis } {
  const frequency = midRankPercentiles(rows.map((row) => row.frequency));
  const scored = rows.flatMap((row, i) => (row.complexity === null ? [] : [i]));
  const complexity = new Map(midRankPercentiles(scored.map((i) => rows[i]!.complexity!)).map((p, k) => [scored[k]!, p]));
  const guideline = percentile / 100;
  const all = rows.flatMap((row, i): Friction[] => {
    if (frequency[i]! < guideline) return [];
    const c = complexity.get(i);
    const complexityPercentile = c === undefined ? null : percentOf(c);
    if (above !== undefined) {
      const count = above.get(row.path) ?? 0;
      return count > 0 ? [{ row, frequencyPercentile: percentOf(frequency[i]!), complexityPercentile, functionsAbove: count }] : [];
    }
    return c !== undefined && c >= guideline ? [{ row, frequencyPercentile: percentOf(frequency[i]!), complexityPercentile, functionsAbove: null }] : [];
  });
  return { all: all.sort((a, b) => byScore(a.row, b.row)), basis: above === undefined ? "percentile" : "functions" };
}

/** Physical lines of each file at HEAD, for the files that are text. */
async function linesOf(root: string, head: string, paths: readonly string[]): Promise<Map<string, number>> {
  const lines = new Map<string, number>();
  const batch = 32;
  for (let start = 0; start < paths.length; start += batch) {
    const slice = paths.slice(start, start + batch);
    const texts = await Promise.all(slice.map((path) => readBlobAt(root, head, path)));
    slice.forEach((path, i) => {
      const text = texts[i];
      if (text === undefined || text.includes("\0")) return;
      lines.set(path, text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);
    });
  }
  return lines;
}

/** Four strictly ascending values at the 50th, 75th, 90th and 97th percentile of the values, so the bands show where change concentrates. */
function bandBreaks(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  const breaks: number[] = [];
  for (const share of [0.5, 0.75, 0.9, 0.97]) breaks.push(Math.max(at(share), (breaks.at(-1) ?? 0) + 1));
  return breaks;
}

function mapBlocks(rows: readonly HotspotRow[], lines: ReadonlyMap<string, number>): Block[] {
  const sized = rows.flatMap((row) => (lines.has(row.path) ? [{ path: row.path, size: lines.get(row.path)!, colour: row.frequency }] : []));
  const largest = [...sized].sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1)).slice(0, MAP_FILES);
  const blocks: Block[] = [
    {
      type: "treemap",
      title: `The ${largest.length} largest files, nested by folder: size is lines, colour is revisions in the window`,
      sizeLabel: "lines",
      colourLabel: "revisions in the window",
      items: largest,
      breaks: bandBreaks(largest.map((item) => item.colour)),
    },
  ];
  blocks.push({ type: "paragraph", text: "Colour bands are rank steps of the files shown: the band edges sit at the 50th, 75th, 90th and 97th percentile of their revisions, so band 5 is the most changed and says nothing about good or bad." });
  if (sized.length > largest.length) blocks.push({ type: "notice", level: "limit", text: `The map and its table show the ${largest.length} files with the most lines of ${sized.length} ranked files; the ${sized.length - largest.length} smaller files are not in it.` });
  if (rows.length > sized.length) blocks.push({ type: "notice", level: "limit", text: `${rows.length - sized.length} ranked files have no text lines to size and are not in the map.` });
  return blocks;
}

function frictionBlocks(friction: readonly Friction[], shown: readonly Friction[], judged: readonly Friction[], percentile: number, basis: ComplexityBasis, complexityLabel: string, considered: number, judgedGuideline: number): Block[] {
  const byFunctions = basis === "functions";
  const table = capRows(
    {
      caption: byFunctions
        ? "Friction list: files in the top change-frequency percentile with a function above the cognitive guideline, by hotspot score"
        : "Friction list: files in the top change-frequency percentile and the top complexity percentile, by hotspot score",
      noun: "files",
      total: friction.length,
      emptyText: "No file is on the friction list.",
      columns: [
        { key: "path", label: "File" },
        { key: "revisions", label: "Revisions", align: "right" },
        { key: "frequencyPercentile", label: "Frequency percentile", align: "right", guideline: { value: percentile, note: "cochange.hotspotPercentile" } },
        ...(byFunctions ? [{ key: "functionsAbove", label: "Functions above the cognitive guideline", align: "right" as const }] : []),
        { key: "complexity", label: complexityLabel, align: "right" },
        { key: "complexityPercentile", label: "Complexity percentile", align: "right", ...(byFunctions ? {} : { guideline: { value: percentile, note: "cochange.hotspotPercentile" } }) },
        { key: "lastChanged", label: "Last changed" },
        { key: "landedChanges", label: "Landed changes", align: "right" },
        { key: "fixes", label: "Fixes landed", align: "right" },
        { key: "fixShare", label: "Fix share of landed changes (%)", align: "right" },
        { key: "reviewFixes", label: "Fixes in review", align: "right" },
        { key: "flag", label: "Flag" },
      ],
      rows: shown.map(({ row, frequencyPercentile, complexityPercentile, functionsAbove }): Record<string, Cell> => ({
        path: row.path,
        revisions: row.frequency,
        frequencyPercentile,
        functionsAbove,
        complexity: row.complexity,
        complexityPercentile,
        lastChanged: isoDate(row.lastChanged),
        landedChanges: row.landedChanges,
        fixes: row.fixes,
        fixShare: row.fixShare === null ? null : percentOf(row.fixShare),
        reviewFixes: row.reviewFixes,
        flag: row.recommendation,
      })),
    },
    shown.length,
    `cochange report hotspots --top ${friction.length}`,
  );
  const how = byFunctions
    ? `A file is complex here when it has a function above the cognitive complexity guideline, read from the stored \`complexity analyse\` result.`
    : `A file is complex here when its complexity percentile is at or above ${percentile}, because no stored \`complexity analyse\` result covers this commit. Run \`complexity analyse\` and then this report again to use the functions above the cognitive guideline instead.`;
  const blocks: Block[] = [
    { type: "paragraph", text: `${friction.length} of ${considered} files are in the top ${100 - percentile} percent in change frequency and are complex. ${how} The list is ordered by hotspot score.` },
    { type: "ranked-table", ...table },
  ];
  if (friction.length > judged.length) blocks.push({ type: "paragraph", text: `The first ${judged.length} files have a judgement (cochange.hotspotJudged is ${judgedGuideline}, a guideline for the length of the page); the other ${friction.length - judged.length} are in the table only.` });
  for (const { row } of judged) {
    blocks.push({ type: "judgement", slot: `flag:${row.path}` }, { type: "judgement", slot: `recommend:${row.path}` });
  }
  return blocks;
}

interface Trend {
  path: string;
  revisions: number;
  samples: { date: string; complexity: number | null; lines: number | null; atHead?: boolean }[];
  summary: { direction: string; changeRatio: number | null; peak: { complexity: number; date: string } | null; lines: { first: number | null; last: number | null } };
}

async function trendOf(context: CommandContext, path: string): Promise<Trend | undefined> {
  try {
    const output = await trendCommand.run({ ...context, positionals: [path], values: { ...context.values, samples: String(TREND_SAMPLES) } });
    return output.results as Trend;
  } catch {
    return undefined;
  }
}

function historyBlocks(trends: readonly (Trend | undefined)[], paths: readonly string[], omitted: number): Block[] {
  const found = trends.flatMap((t) => (t === undefined ? [] : [t]));
  const blocks: Block[] = [
    {
      type: "ranked-table",
      caption: "Complexity and size of the first friction files across their history (cochange trend). The direction compares the first sample with the last sample only: worsening is a rise of at least the guideline, improving a fall of at least the guideline, and a fall in the last step does not change it",
      noun: "friction files",
      total: paths.length + omitted,
      emptyText: "No friction file has a history to sample.",
      columns: [
        { key: "path", label: "File" },
        { key: "revisions", label: "Revisions in history", align: "right" },
        { key: "direction", label: "Direction, first sample to last sample" },
        { key: "change", label: "Change in complexity, first sample to last sample (%)", align: "right", guideline: { value: TREND_GUIDELINE * 100, note: "the trend guideline for worsening" } },
        { key: "peak", label: "Peak complexity", align: "right" },
        { key: "linesFirst", label: "Lines at first sample", align: "right" },
        { key: "linesLast", label: "Lines at last sample", align: "right" },
      ],
      rows: found.map((t): Record<string, Cell> => ({
        path: t.path,
        revisions: t.revisions,
        direction: t.summary.direction,
        change: t.summary.changeRatio === null ? null : percentOf(t.summary.changeRatio),
        peak: t.summary.peak?.complexity ?? null,
        linesFirst: t.summary.lines.first,
        linesLast: t.summary.lines.last,
      })),
    },
  ];
  for (const t of found.slice(0, SPARKLINES)) {
    const points = t.samples.flatMap((s) => (s.complexity === null ? [] : [{ label: s.date.slice(0, 10), value: s.complexity }]));
    if (points.length > 0) blocks.push({ type: "sparkline", title: `${t.path}: indentation complexity across its history`, unit: "indentation complexity", points });
  }
  const atHead = found.filter((t) => t.samples.at(-1)?.atHead === true);
  if (atHead.length > 0) {
    blocks.push({
      type: "notice",
      level: "notice",
      text: `For ${atHead.length} of these files the last sample is the file at HEAD, added because the file at HEAD differs from the file at its last change in the analysed history, so a later change is not in the history (a noise filter or a limit left it out) (${atHead.map((t) => codeSpan(t.path)).join(", ")}).`,
    });
  }
  const missing = paths.length - found.length;
  if (missing > 0) blocks.push({ type: "notice", level: "limit", text: `${missing} of these files have no history to sample, so they are not drawn.` });
  return blocks;
}

const xrayRunLines = (what: string, command: string) => `No stored ${what} for this commit. Run \`${command}\` to store it, then run the report again.`;

function guidelinesOf(analyse: SiblingResult): XrayData["guidelines"] {
  const g = analyse.extra.guidelines as { cognitiveWarn?: unknown; cyclomaticWarn?: unknown; nesting?: unknown; overrides?: unknown } | undefined;
  if (g === undefined || number(g.cognitiveWarn) === null || number(g.cyclomaticWarn) === null || number(g.nesting) === null) return undefined;
  const overrides = number(g.overrides) ?? 0;
  return { cognitive: g.cognitiveWarn as number, cyclomatic: g.cyclomaticWarn as number, nesting: g.nesting as number, note: overrides === 0 ? "complexity.guidelines, the warn level" : `complexity.guidelines defaults; ${overrides} path overrides are configured and the smells column reflects them` };
}

function xrayFunctions(path: string, analyse: SiblingResult, fixes: SiblingResult | undefined): XrayFunction[] {
  const fixed = new Map((fixes?.rows ?? []).flatMap((row) => (typeof row.id === "string" ? [[row.id, row] as const] : [])));
  return analyse.rows
    .filter((row) => row.path === path)
    .map((row): XrayFunction => {
      const id = String(row.id);
      const measured = fixed.get(id);
      return {
        id,
        name: String(row.unit ?? id),
        startLine: number(row.startLine) ?? 0,
        endLine: number(row.endLine) ?? 0,
        length: number(row.length),
        cognitive: number(row.cognitive),
        nesting: number(row.nesting),
        cyclomatic: number(row.cyclomatic),
        labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
        // The stored fix result lists only the functions with a fix, so it cannot give the revisions of the others, and the table omits the column rather than disagree with `complexity report xray`. A function it does not list has no fix.
        revisions: null,
        fixes: fixes === undefined ? null : (number(measured?.fixCommits) ?? 0),
      };
    });
}

function xraySections(shown: readonly Friction[], analyse: SiblingResult | undefined, fixes: SiblingResult | undefined): Section[] {
  const files = shown.slice(0, XRAY_FILES);
  if (files.length === 0) return [{ id: "xray", heading: "X-Ray", blocks: [{ type: "notice", level: "notice", text: "No file is on the friction list, so there is no file to X-Ray." }] }];
  const missing: Block[] = [
    ...(analyse === undefined ? [{ type: "notice" as const, level: "notice" as const, text: xrayRunLines("complexity analyse result", "complexity analyse") }] : []),
    ...(fixes === undefined ? [{ type: "notice" as const, level: "notice" as const, text: xrayRunLines("complexity fixes result", "complexity fixes") }] : []),
  ];
  return files.map(({ row }, i): Section => {
    const heading = `X-Ray: ${row.path}`;
    const id = `xray-${i + 1}`;
    if (analyse === undefined) return { id, heading, blocks: missing };
    const functions = xrayFunctions(row.path, analyse, fixes);
    if (functions.length === 0) return { id, heading, blocks: [{ type: "notice", level: "notice", text: `The stored complexity analyse result lists no functions of ${row.path}, so there is nothing to X-Ray.` }] };
    const data: XrayData = { file: row.path, functions, guidelines: guidelinesOf(analyse), rows: XRAY_ROWS };
    const table = xrayBlocks(data).filter((block) => block.type !== "notice");
    const revisions: Block[] = [{ type: "notice", level: "notice", text: `The table has no revisions column: the stored fix result lists only the functions that have a fix, so it cannot give the revisions of the others. \`complexity report xray ${row.path}\` shows them for its most complex functions, and \`complexity analyse ${row.path} --with-fixes --limit all\` for every function.` }];
    return { id, heading, blocks: [...table, ...missing, ...revisions] };
  });
}

function slots(shown: readonly Friction[]): Slot[] {
  const report = { kind: "report" as const, ref: "hotspots", label: "the repository" };
  return [
    {
      id: "summary",
      title: "Judgement: what the picture says",
      about: report,
      task: "In at most three sentences, say where change and size concentrate and whether the friction list points at a few files or many, citing only values this report shows. When the evidence grade is weak, say the history-based results are tentative.",
      verdicts: [],
      maxChars: 500,
    },
    ...shown.flatMap(({ row }): Slot[] => [
      {
        id: `flag:${row.path}`,
        title: `Judgement: ${row.path}, red flag or code smell`,
        about: { kind: "file", ref: row.path, label: row.path },
        task: "Read the file, and its X-Ray when the report has one. Give the red flag or code smell you judge present, or none-applies. In one or two sentences say what in the file shows it. Cite only values this report shows. A fix is a count of commit messages, not of defects.",
        verdicts: FLAG_VERDICTS,
        maxChars: 400,
      },
      {
        id: `recommend:${row.path}`,
        title: `Judgement: ${row.path}, recommendation`,
        about: { kind: "file", ref: row.path, label: row.path },
        task: "Recommend one: refactor (reduce complexity in place), split (separate responsibilities into files), leave (the signal does not call for work), review (a person should look first), or dismiss (a false positive such as generated or data-table code; the text records why). Give the reason in one or two sentences.",
        verdicts: RECOMMENDATIONS,
        maxChars: 400,
      },
    ]),
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: report,
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the evidence, the exclusions and the missing results shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

function top(context: CommandContext): number {
  const value = context.values.top;
  if (value === undefined) return DEFAULT_FRICTION;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw usageError(`--top must be an integer of at least 1, got "${String(value)}"`);
  return parsed;
}

export const hotspots: ReportKind = {
  summary: "Where change and complexity meet: a treemap of the code, the friction list with each file's history, and an X-Ray of the top files, with a judgement of each file",
  options: { ...windowOptions, "no-refresh": { type: "boolean" }, top: { type: "string" }, ...noCacheOption },
  optionHelp: {
    since: "analyse history from this date (ISO 8601); needed on a shallow clone",
    until: "analyse history up to this date (ISO 8601, exclusive)",
    "no-refresh": "read the history cache without bringing it up to date",
    top: `files in the friction list (default ${DEFAULT_FRICTION}); the first cochange.hotspotJudged get judgement slots, the first ${TREND_FILES} a history and the first ${XRAY_FILES} an X-Ray`,
    "no-cache": "compute the hotspot ranking again instead of reading the stored one",
  },
  /** The stored complexity results the page reads: the friction list, the X-Ray and the fix figures change when one is stored or replaced. */
  dependsOn(context: CommandContext) {
    return ["analyse", "fixes"].map((command) => {
      try {
        const stat = statSync(reportPath(context.repo.root, "complexity", command));
        return [command, stat.mtimeMs, stat.size];
      } catch {
        return [command, null, null];
      }
    });
  },
  async build(context: CommandContext): Promise<ReportBuild> {
    const limit = top(context);
    const output = await hotspotsCommand.run(context);
    // Read what the ranking left out before the history commands below record their own drops.
    const excluded = excludedCounts((output.extra as { filtersApplied: FiltersApplied }).filtersApplied, droppedCounts(), builtinOmissions());
    const extra = output.extra as { evidence: Evidence; filtersApplied: FiltersApplied; complexitySource: string; window: { since: string; until: string } };
    const { evidence } = extra;
    const rows = orderedHotspots(output);
    const root = context.repo.root;
    const head = context.repo.head;
    const settings = readSettings(context.config);
    const percentile = settings.hotspotPercentile;

    const analyse = readSiblingResult(root, "complexity", "analyse", head);
    const fixes = readSiblingResult(root, "complexity", "fixes", head);
    const { all: friction, basis } = frictionOf(rows, percentile, cognitiveAbove(analyse));
    const shown = friction.slice(0, limit);
    const judged = shown.slice(0, settings.hotspotJudged);
    const lines = await linesOf(root, head, rows.map((row) => row.path));

    const trendPaths = shown.slice(0, TREND_FILES).map((f) => f.row.path);
    const trends = await Promise.all(trendPaths.map((path) => trendOf(context, path)));
    const complexityLabel = extra.complexitySource === "complexity-report" ? "Complexity (complexity files)" : "Complexity (indentation)";

    const inputs = (output.inputs ?? {}) as Record<string, unknown>;
    const read = [analyse, fixes].flatMap((s) => (s === undefined ? [] : [{ report: s.report, head: s.head, config: s.config }]));

    const sections: Section[] = [
      { id: "summary", heading: "What the picture says", blocks: [{ type: "judgement", slot: "summary" }] },
      { id: "map", heading: "Map of the code", blocks: mapBlocks(rows, lines) },
      {
        id: "friction",
        heading: "Friction list",
        blocks:
          friction.length === 0
            ? [{ type: "notice", level: "notice", text: basis === "functions" ? `No file in the top ${100 - percentile} percent of change frequency among the ${rows.length} files ranked has a function above the cognitive guideline.` : `No file is in the top ${100 - percentile} percent of both change frequency and complexity among the ${rows.length} files ranked.` }]
            : [
                ...frictionBlocks(friction, shown, judged, percentile, basis, complexityLabel, rows.length, settings.hotspotJudged),
              ],
      },
      { id: "history", heading: "History of the top files", blocks: trendPaths.length === 0 ? [{ type: "notice", level: "notice", text: "There is no friction file to draw." }] : historyBlocks(trends, trendPaths, Math.max(0, shown.length - trendPaths.length)) },
      ...xraySections(shown, analyse, fixes),
    ];

    return dropEmptySlots({
      title: "Hotspots",
      inputs: {
        since: context.values.since ?? null,
        until: context.values.until ?? null,
        top: limit,
        complexityReport: inputs.complexityReport ?? null,
        storedResultsRead: read,
      },
      header: {
        evidenceGrade: evidence.grade,
        historyWindow: historyWindowText(evidence, extra.window),
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections,
      limits: [
        "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
        basis === "functions"
          ? `The friction list is the files at or above the ${percentile}th percentile of change frequency (cochange.hotspotPercentile) that have a function above the cognitive complexity guideline (from the stored \`complexity analyse\` result). A percentile is a rank among the ${rows.length} files ranked, so it moves when files are added.`
          : `The friction list is the files at or above the ${percentile}th percentile (cochange.hotspotPercentile) of both change frequency and complexity, because no stored \`complexity analyse\` result covers this commit; run \`complexity analyse\` and this report again to list files with a function above the cognitive guideline instead. A percentile is a rank among the ${rows.length} files ranked, so it moves when files are added.`,
        `The friction list shows ${shown.length} of ${friction.length} files; the judgement covers the first ${judged.length} (cochange.hotspotJudged), the history table covers the first ${Math.min(TREND_FILES, shown.length)} (sparklines of the first ${Math.min(SPARKLINES, shown.length)}) and the X-Ray the first ${Math.min(XRAY_FILES, shown.length)}.`,
        extra.complexitySource === "indentation" ? "The Complexity column is the file's indentation complexity computed by this report; \`complexity files\` stores the same figure for this commit." : "The Complexity column is the file's indentation complexity from the stored \`complexity files\` result.",
        "Revisions count every commit that touched the file in the window. Landed changes count the merged changes (a pull request, or a commit on the main line) that touched it, so they are fewer than revisions when a change has several commits; the fix share is fixes landed divided by landed changes. A fix is a count of commit messages, not of defects, and fixes in review are fix-like commits made on a branch before it merged.",
        ...(evidence.grade === "weak" ? ["The evidence grade is weak, so history-based results are tentative and static signals should lead."] : []),
        ...(evidence.truncated.shallow ? [`The clone is shallow, so history before ${evidence.truncated.availableSince === null ? "its boundary" : isoDate(evidence.truncated.availableSince)} is missing.`] : []),
        ...(evidence.commitSize.shifted ? ["A change of merge policy shifts what a commit means, so compare windows within one policy."] : []),
        ...(analyse === undefined || fixes === undefined ? ["The X-Ray reads the complexity plugin's stored results and never computes them; a missing one is named in the section."] : []),
      ],
      slots: slots(judged),
    });
  },
};

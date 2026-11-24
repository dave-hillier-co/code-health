import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild } from "@code-health/report/report-model";
import { excludedCounts, historyWindowText, isoDate } from "@code-health/history/report-header";
import type { Evidence } from "@code-health/history/evidence";
import type { FiltersApplied } from "@code-health/history/noise";
import { noCacheOption } from "@code-health/history/results-cache";
import { dropEmptySlots } from "@code-health/report/empty-block";
import { capRows } from "@code-health/report/table-cap";
import type { RankedTableData } from "@code-health/report/components/ranked-table";
import { testClassifier } from "@code-health/parse/test-files";
import { command as clustersCommand } from "../commands/clusters.ts";
import { command as couplingCommand } from "../commands/coupling.ts";
import { readSettings } from "../config.ts";
import { EXPECTED_LABEL, EXPECTED_REASONS, expectedReason, type ExpectedReason } from "../expected-pair.ts";
import type { CouplingTrend } from "../coupling-trend.ts";
import { readSiblingResult, type SiblingResult } from "../sibling-reports.ts";
import { windowOptions } from "../window-options.ts";

/** Rows of each table. The command prints the rest. */
const TOP_PAIRS = 15;
const TOP_FILES = 15;
const TOP_CLUSTERS = 10;
const TOP_HIDDEN = 10;
/** Rows of the table of expected pairs, and of the pairs just under the support floor. */
const TOP_EXPECTED = 10;
const TOP_BELOW_FLOOR = 10;
/** Fewer qualifying pairs than this is thin data: the report says how many there are and how many fall just under the floor. */
const FEW_PAIRS = 5;
/** How far under the support floor "just below" reaches, in shared changes. */
const BELOW_FLOOR_REACH = 2;
/** The pairs that get a judgement slot. */
const JUDGED_PAIRS = 5;
const MEMBERS_SHOWN = 4;
const MATRIX_LABEL = 30;

export const PAIR_VERDICTS = [
  "real-locality-review",
  "real-structure-break",
  "real-leave",
  "incidental-locality-review",
  "incidental-structure-break",
  "incidental-leave",
];

interface PairRow {
  path: string;
  pathKind: string;
  with: string;
  withKind: string;
  degree: number;
  aboveGuideline: boolean;
  confidence: number;
  reverseConfidence: number;
  support: number;
  distance: number;
  findings: string[];
  trend: CouplingTrend | null;
  degreeChange: number | null;
  previousDegree: number | null;
  previousSupport: number | null;
}

/** A pair with the reason it is expected, or null for a pair of production files. */
interface ClassifiedPair {
  row: PairRow;
  reason: ExpectedReason | null;
}

interface ClusterRow {
  files: string[];
  size: number;
  folders: number;
  spread: number;
  meanDegree: number;
  magnets: string[];
  findings: string[];
}

interface PreviousWindow {
  since: string;
  until: string;
  eligibleChanges: number;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round1 = (value: number) => Math.round(value * 10) / 10;
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

const TREND_ARROW: Record<CouplingTrend, string> = { stronger: "↑", stable: "→", weaker: "↓" };

function trendCell(row: PairRow): string {
  if (row.trend === null || row.degreeChange === null) return "no earlier window";
  const never = row.previousSupport === 0 ? ", shared no change before" : "";
  return `${TREND_ARROW[row.trend]} ${row.trend} (${signed(row.degreeChange)} points${never})`;
}

const pairRef = (row: PairRow) => `${row.path} <-> ${row.with}`;

/** A ranked table cut to its first rows, with the command that lists the rest. */
const cappedTable = (table: RankedTableData, max: number, command: string): Block => ({ type: "ranked-table", ...capRows(table, max, command) });

const PAIR_ORDER = "Sorted by degree, then shared changes, then path; pairs under the degree guideline come after the others.";

/**
 * The line that says so when the judged cut falls inside a tie. The table sorts by degree, then shared changes, then
 * path, so pairs that tie on degree and shared changes are in path order and that order ranks nothing. Null when the
 * pair after the last judged one differs from it in degree or shared changes.
 */
export function tieNotice(production: readonly PairRow[], judged: number): Block | null {
  if (production.length <= judged) return null;
  const same = (a: PairRow, b: PairRow) => a.degree === b.degree && a.support === b.support;
  const edge = production[judged - 1]!;
  if (!same(edge, production[judged]!)) return null;
  let first = judged - 1;
  while (first > 0 && same(production[first - 1]!, edge)) first--;
  let last = judged;
  while (last + 1 < production.length && same(production[last + 1]!, edge)) last++;
  return {
    type: "notice",
    level: "notice",
    text: `Pairs ${first + 1} to ${last + 1} tie on degree and shared changes (degree ${edge.degree}, ${edge.support} shared changes); the order among them is by path, so the ${judged} judged pairs are the first ${judged} by path and not the ${judged} strongest.`,
  };
}

const trendOf = (previous: PreviousWindow | undefined): boolean => previous !== undefined && previous.eligibleChanges > 0;

function pairColumns(guideline: { minDegree: number } | null, withTrend: boolean) {
  return [
    { key: "file", label: "File" },
    { key: "with", label: "Changes with" },
    { key: "degree", label: "Degree (%)", align: "right" as const, ...(guideline === null ? {} : { guideline: { value: guideline.minDegree, note: "cochange.minDegree" } }) },
    { key: "support", label: "Shared changes", align: "right" as const },
    { key: "confidence", label: "Confidence file to with (%)", align: "right" as const },
    { key: "reverse", label: "Confidence with to file (%)", align: "right" as const },
    { key: "distance", label: "Distance (folder hops)", align: "right" as const },
    ...(withTrend ? [{ key: "trend", label: "Trend" }] : []),
  ];
}

const pairCells = (row: PairRow, withTrend: boolean): Record<string, Cell> => ({
  file: row.path,
  with: row.with,
  degree: row.degree,
  support: row.support,
  confidence: row.confidence,
  reverse: row.reverseConfidence,
  distance: row.distance,
  ...(withTrend ? { trend: trendCell(row) } : {}),
});

function pairsSection(production: readonly PairRow[], total: number, settings: { minDegree: number }, withTrend: boolean): Block[] {
  return [
    cappedTable(
      {
        caption: `Most strongly coupled pairs of production files${withTrend ? ", with how each moved since the previous window" : ""}. ${PAIR_ORDER}`,
        noun: "pairs",
        total: production.length,
        emptyText: `None of the ${total} pairs that reach the support floor is a pair of production files; they are all in the table of expected pairs.`,
        columns: pairColumns(settings, withTrend),
        rows: production.map((row) => pairCells(row, withTrend)),
      },
      TOP_PAIRS,
      "cochange coupling",
    ),
  ];
}

function expectedSection(expected: readonly ClassifiedPair[], settings: { minDegree: number }): Block[] {
  const counts = EXPECTED_REASONS.map((reason) => ({ reason, count: expected.filter((e) => e.reason === reason).length })).filter((c) => c.count > 0);
  const table = cappedTable(
    {
      caption: `Expected pairs, listed apart and not judged: two test files, a test, fixture or golden file with what it checks, a C or C++ header with its source file, two build manifests of one toolchain, two data files of one format, or a file that is not code (documentation, configuration) with any other file. ${PAIR_ORDER}`,
      noun: "pairs",
      total: expected.length,
      emptyText: "No pair is an expected pair: every pair that reaches the support floor is a pair of production files.",
      columns: [{ key: "file", label: "File" }, { key: "with", label: "Changes with" }, { key: "why", label: "Why expected" }, ...pairColumns(settings, false).filter((c) => ["degree", "support"].includes(c.key))],
      rows: expected.map(({ row, reason }): Record<string, Cell> => ({ file: row.path, with: row.with, why: EXPECTED_LABEL[reason!], degree: row.degree, support: row.support })),
    },
    TOP_EXPECTED,
    "cochange coupling",
  );
  return [
    ...(counts.length === 0 ? [] : [{ type: "notice" as const, level: "notice" as const, text: `${expected.length} ${expected.length === 1 ? "pair is an expected pair" : "pairs are expected pairs"} (${counts.map((c) => `${c.count} ${EXPECTED_LABEL[c.reason]}`).join(", ")}). Expected pairs are not judged; the table below lists them.` }]),
    table,
  ];
}

function trendBlocks(rows: readonly PairRow[], total: number, settings: { tolerance: number }, previous: PreviousWindow | undefined): Block[] {
  if (!trendOf(previous)) return [{ type: "notice", level: "notice", text: "The window before the current one holds no eligible change, so no pair has a trend." }];
  const counts = { stronger: 0, stable: 0, weaker: 0 };
  for (const row of rows) if (row.trend !== null) counts[row.trend]++;
  return [
    {
      type: "facts",
      caption: `Trend of all ${total} pairs against ${isoDate(previous!.since)} to ${isoDate(previous!.until)}`,
      facts: [
        { label: "Stronger", value: String(counts.stronger) },
        { label: "Stable", value: String(counts.stable) },
        { label: "Weaker", value: String(counts.weaker) },
        { label: "Pairs that shared no change in the previous window", value: String(rows.filter((row) => row.previousSupport === 0).length) },
        { label: "Stable means a change in degree of at most", value: `${settings.tolerance} points (guideline cochange.couplingTrendTolerance, a judgement call)` },
        { label: "Eligible changes in the previous window", value: String(previous!.eligibleChanges) },
      ],
    },
  ];
}

/** The line for thin data, then the pairs just under the support floor as a capped list that gets no judgement. */
function thinBlocks(total: number, minSupport: number, below: readonly PairRow[]): Block[] {
  const low = Math.max(1, minSupport - BELOW_FLOOR_REACH);
  const range = low === minSupport - 1 ? `${low}` : `${low} to ${minSupport - 1}`;
  const reach = `${total} ${total === 1 ? "pair reaches" : "pairs reach"} the support floor of ${minSupport} shared changes (cochange.minSupport), which is too few to rank. The floor was not lowered.`;
  if (below.length === 0) return [{ type: "notice", level: "notice", text: `${reach} No other pair shares ${range} changes.` }];
  return [
    { type: "notice", level: "notice", text: `${reach} ${below.length} further ${below.length === 1 ? "pair shares" : "pairs share"} ${range} changes, just below it.` },
    cappedTable(
      {
        caption: `Pairs just below the support floor, with ${range} shared changes. They are not judged. ${PAIR_ORDER}`,
        noun: "pairs",
        total: below.length,
        columns: pairColumns(null, false),
        rows: below.map((row) => pairCells(row, false)),
      },
      TOP_BELOW_FLOOR,
      `cochange coupling --min-support ${low}`,
    ),
  ];
}

interface FileSum {
  file: string;
  shared: number;
  partners: number;
  strongest: number;
}

function sumsOf(rows: readonly PairRow[]): FileSum[] {
  const sums = new Map<string, FileSum>();
  const add = (file: string, row: PairRow) => {
    const sum = sums.get(file) ?? { file, shared: 0, partners: 0, strongest: 0 };
    sum.shared += row.support;
    sum.partners++;
    sum.strongest = Math.max(sum.strongest, row.degree);
    sums.set(file, sum);
  };
  for (const row of rows) {
    add(row.path, row);
    add(row.with, row);
  }
  return [...sums.values()].sort((x, y) => y.shared - x.shared || y.partners - x.partners || byBytes(x.file, y.file));
}

const shortLabel = (file: string) => (file.length <= MATRIX_LABEL ? file : `…${file.slice(file.length - MATRIX_LABEL + 1)}`);

function sumSection(sums: readonly FileSum[]): Block[] {
  return [
    {
      type: "ranked-table",
      caption: "Sum of coupling per file: the shared changes of all the production pairs a file is in. Sorted by sum, then coupled files, then path",
      noun: "files",
      total: sums.length,
      emptyText: "No production pair reaches the support floor, so no file has a sum of coupling.",
      columns: [
        { key: "file", label: "File" },
        { key: "shared", label: "Sum of shared changes", align: "right" },
        { key: "partners", label: "Coupled files", align: "right" },
        { key: "strongest", label: "Strongest degree (%)", align: "right" },
      ],
      rows: sums.slice(0, TOP_FILES).map((s): Record<string, Cell> => ({ file: s.file, shared: s.shared, partners: s.partners, strongest: round1(s.strongest) })),
    },
  ];
}

function matrixSection(rows: readonly PairRow[], sums: readonly FileSum[], minSupport: number): Block[] {
  const files = sums.slice(0, TOP_FILES).map((s) => s.file);
  if (files.length < 2) return [];
  const shared = new Map(rows.map((row) => [`${row.path}\0${row.with}`, row.support]));
  const between = (a: string, b: string) => shared.get(`${a}\0${b}`) ?? shared.get(`${b}\0${a}`) ?? null;
  const labels = files.map(shortLabel);
  return [
    {
      type: "matrix",
      title: `Shared changes between the top ${files.length} files by sum of coupling`,
      valueLabel: `shared changes (none where the pair shares fewer than ${minSupport}, the support floor)`,
      rows: labels,
      columns: labels,
      cells: files.map((a) => files.map((b) => (a === b ? null : between(a, b)))),
    },
  ];
}

function degreeHistogram(rows: readonly PairRow[]): Block {
  const bins = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10} to ${i === 9 ? 100 : (i + 1) * 10 - 1}`, count: 0 }));
  for (const row of rows) bins[Math.min(9, Math.floor(row.degree / 10))]!.count++;
  return { type: "histogram", title: "Distribution of pair degrees (percent)", unit: "pairs", bins };
}

function clustersSection(rows: readonly ClusterRow[]): Block[] {
  if (rows.length === 0) {
    return [
      {
        type: "ranked-table",
        caption: "Clusters of mutually coupled files, with their spread",
        columns: [{ key: "files", label: "Files" }],
        rows: [],
        emptyText: "No cluster: no pair reaches both the support floor and the degree guideline, which a cluster requires.",
      },
    ];
  }
  const members = (row: ClusterRow) => {
    const listed = row.files.slice(0, MEMBERS_SHOWN).join(", ");
    return row.files.length > MEMBERS_SHOWN ? `${listed} and ${row.files.length - MEMBERS_SHOWN} more` : listed;
  };
  return [
    {
      type: "ranked-table",
      caption: "Clusters of mutually coupled files, with their spread",
      noun: "clusters",
      total: rows.length,
      columns: [
        { key: "files", label: "Files" },
        { key: "size", label: "Files in cluster", align: "right" },
        { key: "folders", label: "Folders", align: "right" },
        { key: "spread", label: "Spread (mean tree distance)", align: "right" },
        { key: "degree", label: "Mean degree (%)", align: "right" },
        { key: "findings", label: "Findings" },
      ],
      rows: rows.slice(0, TOP_CLUSTERS).map((row): Record<string, Cell> => ({
        files: members(row),
        size: row.size,
        folders: row.folders,
        spread: row.spread,
        degree: row.meanDegree,
        findings: row.findings.length === 0 ? null : row.findings.join(", "),
      })),
    },
  ];
}

function hiddenSection(stored: SiblingResult | undefined): { blocks: Block[]; read: { report: string; head: string; config: string } | null } {
  if (stored === undefined) {
    return {
      blocks: [{ type: "notice", level: "notice", text: "No stored structure hidden result for this commit. Run `structure hidden` to store it, then run this report again." }],
      read: null,
    };
  }
  const rows = stored.rows;
  const coChange = (row: Record<string, unknown>) => (typeof row.coChange === "object" && row.coChange !== null ? (row.coChange as Record<string, unknown>) : {});
  const statics = (row: Record<string, unknown>) => (typeof row.staticCoupling === "object" && row.staticCoupling !== null ? (row.staticCoupling as Record<string, unknown>) : {});
  return {
    read: { report: stored.report, head: stored.head, config: stored.config },
    blocks:
      rows.length === 0
        ? [{ type: "notice", level: "notice", text: "The stored structure hidden result lists no pair with high co-change and low static coupling." }]
        : [
            {
              type: "ranked-table",
              caption: "Pairs with high co-change and low static coupling, from structure hidden",
              noun: "pairs",
              total: rows.length,
              columns: [
                { key: "from", label: "Module" },
                { key: "to", label: "Module" },
                { key: "level", label: "Level" },
                { key: "shared", label: "Shared changes", align: "right" },
                { key: "expected", label: "Expected by chance", align: "right" },
                { key: "sites", label: "Static reference sites", align: "right" },
              ],
              rows: rows.slice(0, TOP_HIDDEN).map((row): Record<string, Cell> => ({
                from: text(row.from),
                to: text(row.to),
                level: text(row.level),
                shared: number(coChange(row).shared),
                expected: number(coChange(row).expected) === null ? null : round1(number(coChange(row).expected)!),
                sites: number(statics(row).sites),
              })),
            },
          ],
  };
}

/** The pairs that share fewer changes than the support floor, down to BELOW_FLOOR_REACH changes under it. */
async function pairsBelowFloor(context: CommandContext, minSupport: number): Promise<PairRow[]> {
  const low = Math.max(1, minSupport - BELOW_FLOOR_REACH);
  if (low >= minSupport) return [];
  const output = await couplingCommand.run({ ...context, values: { ...context.values, "min-support": String(low) } });
  return (output.results as unknown as PairRow[]).filter((row) => row.support < minSupport);
}

function excludedBlock(excluded: ExcludedCount[]): Block {
  return {
    type: "ranked-table",
    caption: "What the run left out, with counts",
    numbered: false,
    columns: [
      { key: "what", label: "Left out" },
      { key: "count", label: "Count", align: "right" },
    ],
    rows: excluded.map((e): Record<string, Cell> => ({ what: e.what, count: e.count })),
  };
}

function slots(judged: readonly PairRow[]): Slot[] {
  const pairSlots = judged.map((row, i): Slot => ({
    id: `pair-${i + 1}`,
    title: `Judgement: pair ${i + 1}`,
    about: { kind: "pair", ref: pairRef(row), label: `${row.path} and ${row.with}` },
    task:
      "Is this coupling real (a shared design decision) or incidental (files that change together for another reason)? Start the text with the reason: shared constants, a registry, a protocol, tests, generated code, a data format or another. " +
      "The verdict names real or incidental and the handoff: locality-review (should the files live together), structure-break (a dependency to break) or leave. Cite only values shown here; say when the evidence makes it tentative.",
    verdicts: PAIR_VERDICTS,
    maxChars: 320,
  }));
  return [
    ...pairSlots,
    {
      id: "summary",
      title: "Judgement: what the coupling says about this repository",
      about: { kind: "report", ref: "coupling", label: "the repository" },
      task:
        "In at most three sentences, say what the pairs, sums, clusters and trends together show, and where to look first. Cite only values shown in this report. Say when the evidence grade makes it tentative.",
      verdicts: [],
      maxChars: 500,
    },
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: { kind: "report", ref: "coupling", label: "the repository" },
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the evidence, the exclusions, the trend window and the missing results shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

function limitsOf(evidence: Evidence, settings: { minSupport: number; tolerance: number }, previous: PreviousWindow | undefined, hiddenMissing: boolean): string[] {
  return [
    "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
    "A pair where either side is a test, a fixture or a golden file, or where the sides are a C or C++ header and its source file, two build or packaging manifests of one toolchain (go.mod and go.work, Dockerfile variants, package.json and its lockfile), or two data or configuration files of one format, is an expected pair. It is listed in its own table and not judged.",
    `Coupling counts changes that touched both files in the window, over changes at or below the changeset limit; a larger change counts on neither side. A pair that shares fewer than ${settings.minSupport} changes (the support floor) is not listed.`,
    "Files that change together may share a design decision, or only a shared constant, a registry, a protocol, tests or generated code. The numbers cannot tell these apart; the judgements say which it is.",
    `Each table shows the top rows of its result and says how many rows it leaves out; \`cochange coupling\` and \`cochange clusters\` print the rest.`,
    previous === undefined || previous.eligibleChanges === 0
      ? "The window before the current one holds no eligible change, so no trend is shown."
      : `The trend compares each pair's degree with its degree in the previous window of the same length (${isoDate(previous.since)} to ${isoDate(previous.until)}, ${previous.eligibleChanges} eligible changes). A pair that was young or rare then has a noisy earlier degree, and stable means a change of at most ${settings.tolerance} points.`,
    ...(evidence.grade === "weak" ? ["The evidence grade is weak, so history-based results are tentative and static signals should lead."] : []),
    ...(evidence.truncated.shallow ? ["The clone is shallow, so history before its boundary is missing, and the previous window may be cut short."] : []),
    ...(evidence.commitSize.shifted ? ["A change of merge policy shifts what a commit means, so compare windows within one policy."] : []),
    ...(hiddenMissing ? ["Hidden coupling is read from structure's stored result and never computed here, so none is shown until `structure hidden` has run for this commit."] : []),
  ];
}

export const coupling: ReportKind = {
  summary: "Coupled pairs with their trend, sum of coupling per file, a matrix of the top files, clusters and hidden coupling, with a judgement of each top pair",
  options: { ...windowOptions, "no-refresh": { type: "boolean" }, ...noCacheOption },
  optionHelp: {
    since: "analyse history from this date (ISO 8601); needed on a shallow clone",
    until: "analyse history up to this date (ISO 8601, exclusive)",
    "no-refresh": "read the history cache without bringing it up to date",
    "no-cache": "compute the pairs and clusters again instead of reading the stored ones",
  },
  async build(context: CommandContext): Promise<ReportBuild> {
    const pairContext: CommandContext = { ...context, values: { ...context.values, trend: true } };
    const pairOutput = await couplingCommand.run(pairContext);
    const clusterOutput = await clustersCommand.run(context);
    const extra = pairOutput.extra as { evidence: Evidence; filtersApplied: FiltersApplied; window: { since: string; until: string }; trendWindows?: { previous: PreviousWindow }; population: { eligibleChanges: number } };
    const { evidence } = extra;
    const rows = pairOutput.results as unknown as PairRow[];
    const clusters = clusterOutput.results as unknown as ClusterRow[];
    const previous = extra.trendWindows?.previous;
    const settings = readSettings(context.config);
    const guideline = { minDegree: settings.minDegree, tolerance: settings.couplingTrendTolerance };

    const hidden = hiddenSection(readSiblingResult(context.repo.root, "structure", "hidden", context.repo.head));
    const isTest = testClassifier(context.config.effective.testPatterns);
    const classified = rows.map((row): ClassifiedPair => ({ row, reason: expectedReason({ path: row.path, code: row.pathKind === "code" }, { path: row.with, code: row.withKind === "code" }, isTest) }));
    const production = classified.filter((c) => c.reason === null).map((c) => c.row);
    const expected = classified.filter((c) => c.reason !== null);
    const sums = sumsOf(production);
    const judged = production.slice(0, JUDGED_PAIRS);
    const excluded = excludedCounts(extra.filtersApplied, droppedCounts(), builtinOmissions(), { leftOutOf: "the rankings", oversizedNote: "counted on neither side of any ratio" });
    const inputs = pairOutput.inputs as { minSupport: number };
    const withTrend = trendOf(previous);
    const thin = rows.length < FEW_PAIRS;
    const below = thin ? await pairsBelowFloor(context, inputs.minSupport) : [];

    const tie = tieNotice(production, JUDGED_PAIRS);
    const pairsHeading: Block[] = [
      ...(thin ? thinBlocks(rows.length, inputs.minSupport, below) : []),
      ...(rows.length === 0
        ? []
        : [
            ...pairsSection(production, rows.length, guideline, withTrend),
            ...(tie === null ? [] : [tie]),
            ...judged.map((_, i): Block => ({ type: "judgement", slot: `pair-${i + 1}` })),
            ...expectedSection(expected, guideline),
            ...trendBlocks(rows, rows.length, guideline, previous),
            degreeHistogram(rows),
          ]),
    ];

    return dropEmptySlots({
      title: "Coupling report",
      inputs: {
        since: context.values.since ?? null,
        until: context.values.until ?? null,
        minSupport: inputs.minSupport,
        degreeGuideline: settings.minDegree,
        trendTolerance: settings.couplingTrendTolerance,
        storedResultsRead: hidden.read === null ? [] : [hidden.read],
      },
      header: {
        evidenceGrade: evidence.grade,
        historyWindow: historyWindowText(evidence, extra.window, previous === undefined ? "" : `; the previous window for trends is ${isoDate(previous.since)} to ${isoDate(previous.until)}`),
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections: [
        { id: "summary", heading: "What the coupling says", blocks: [{ type: "judgement", slot: "summary" }] },
        { id: "pairs", heading: "Coupled pairs", blocks: pairsHeading },
        { id: "sums", heading: "Sum of coupling per file", blocks: [...sumSection(sums), ...matrixSection(rows, sums, inputs.minSupport)] },
        { id: "clusters", heading: "Clusters", blocks: clustersSection(clusters) },
        { id: "hidden", heading: "Hidden coupling", blocks: hidden.blocks },
        { id: "excluded", heading: "What was excluded", blocks: [excludedBlock(excluded)] },
      ],
      limits: limitsOf(evidence, { minSupport: inputs.minSupport, tolerance: settings.couplingTrendTolerance }, previous, hidden.read === null),
      slots: slots(judged),
    });
  },
};

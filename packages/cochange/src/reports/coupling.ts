import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild } from "@code-health/report/report-model";
import type { Evidence } from "@code-health/history/evidence";
import type { FiltersApplied } from "@code-health/history/noise";
import { noCacheOption } from "@code-health/history/results-cache";
import { command as clustersCommand } from "../commands/clusters.ts";
import { command as couplingCommand } from "../commands/coupling.ts";
import { readSettings } from "../config.ts";
import type { CouplingTrend } from "../coupling-trend.ts";
import { readSiblingResult, type SiblingResult } from "../sibling-reports.ts";
import { windowOptions } from "../window-options.ts";

/** Rows of each table. The command prints the rest. */
const TOP_PAIRS = 15;
const TOP_FILES = 15;
const TOP_CLUSTERS = 10;
const TOP_HIDDEN = 10;
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
  with: string;
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

const isoDate = (value: string) => value.slice(0, 10);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round1 = (value: number) => Math.round(value * 10) / 10;
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

const COMMIT_FILTERS: [keyof FiltersApplied["dropped"], string][] = [
  ["outsideWindow", "commits outside the analysis window"],
  ["shallowBoundaryCommits", "shallow boundary commits"],
  ["importedCommits", "commits of imported history"],
  ["blameIgnoredCommits", "commits in the blame ignore file"],
  ["botCommits", "commits by bots and service accounts"],
  ["suiteCommits", "commits trailed by this suite"],
  ["emptyAfterFiltering", "commits with no file left after filtering"],
];
const CHANGE_FILTERS: [keyof FiltersApplied["dropped"], string][] = [
  ["pureRenames", "file changes that only rename"],
  ["excludedByGlob", "file changes matching exclude globs"],
  ["lockfiles", "lockfile changes"],
  ["generated", "generated file changes"],
  ["vendored", "vendored file changes"],
];
const FILE_KINDS: Record<string, string> = { generated: "generated files", vendored: "vendored files", nonCode: "non-code files", tests: "test files" };

function excludedCounts(filters: FiltersApplied, files: Record<string, number>, builtin: Record<string, number>): ExcludedCount[] {
  return [
    ...[...COMMIT_FILTERS, ...CHANGE_FILTERS].map(([key, what]) => ({ what, count: filters.dropped[key] })),
    { what: `changes over the changeset limit of ${filters.maxChangesetSize} files, counted on neither side of any ratio`, count: filters.oversizedChanges },
    ...Object.entries(files).map(([kind, count]) => ({ what: `${FILE_KINDS[kind] ?? kind} left out of the rankings`, count })),
    ...Object.entries(builtin).map(([entry, count]) => ({ what: `files under the built-in exclude ${entry}`, count })),
  ];
}

const TREND_ARROW: Record<CouplingTrend, string> = { stronger: "↑", stable: "→", weaker: "↓" };

function trendCell(row: PairRow): string {
  if (row.trend === null || row.degreeChange === null) return "no earlier window";
  const never = row.previousSupport === 0 ? ", shared no change before" : "";
  return `${TREND_ARROW[row.trend]} ${row.trend} (${signed(row.degreeChange)} points${never})`;
}

const pairRef = (row: PairRow) => `${row.path} <-> ${row.with}`;

function pairsSection(rows: readonly PairRow[], total: number, settings: { minDegree: number; tolerance: number }, previous: PreviousWindow | undefined): Block[] {
  const shown = rows.slice(0, TOP_PAIRS);
  const counts = { stronger: 0, stable: 0, weaker: 0 };
  for (const row of rows) if (row.trend !== null) counts[row.trend]++;
  const blocks: Block[] = [
    {
      type: "ranked-table",
      caption: "Most strongly coupled pairs of files, with how each moved since the previous window",
      noun: "pairs",
      total,
      columns: [
        { key: "file", label: "File" },
        { key: "with", label: "Changes with" },
        { key: "degree", label: "Degree (%)", align: "right", guideline: { value: settings.minDegree, note: "cochange.minDegree" } },
        { key: "support", label: "Shared changes", align: "right" },
        { key: "confidence", label: "Confidence file to with (%)", align: "right" },
        { key: "reverse", label: "Confidence with to file (%)", align: "right" },
        { key: "distance", label: "Distance (folder hops)", align: "right" },
        { key: "trend", label: "Trend" },
      ],
      rows: shown.map((row): Record<string, Cell> => ({
        file: row.path,
        with: row.with,
        degree: row.degree,
        support: row.support,
        confidence: row.confidence,
        reverse: row.reverseConfidence,
        distance: row.distance,
        trend: trendCell(row),
      })),
    },
  ];
  if (previous === undefined || previous.eligibleChanges === 0) {
    blocks.push({ type: "notice", level: "notice", text: "The window before the current one holds no eligible change, so no pair has a trend." });
  } else {
    blocks.push({
      type: "facts",
      caption: `Trend of all ${total} pairs against ${isoDate(previous.since)} to ${isoDate(previous.until)}`,
      facts: [
        { label: "Stronger", value: String(counts.stronger) },
        { label: "Stable", value: String(counts.stable) },
        { label: "Weaker", value: String(counts.weaker) },
        { label: "Pairs that shared no change in the previous window", value: String(rows.filter((row) => row.previousSupport === 0).length) },
        { label: "Stable means a change in degree of at most", value: `${settings.tolerance} points (guideline cochange.couplingTrendTolerance, a judgement call)` },
        { label: "Eligible changes in the previous window", value: String(previous.eligibleChanges) },
      ],
    });
  }
  return blocks;
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
      caption: "Sum of coupling per file: the shared changes of all the pairs a file is in",
      noun: "files",
      total: sums.length,
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
  if (rows.length === 0) return [{ type: "notice", level: "notice", text: "No cluster: no pair reaches both the support floor and the degree guideline, which a cluster requires." }];
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
    const sums = sumsOf(rows);
    const judged = rows.slice(0, JUDGED_PAIRS);
    const excluded = excludedCounts(extra.filtersApplied, droppedCounts(), builtinOmissions());
    const inputs = pairOutput.inputs as { minSupport: number };

    const pairsHeading: Block[] =
      rows.length === 0
        ? [{ type: "notice", level: "notice", text: `No pair shares at least ${inputs.minSupport} changes. The support floor was not lowered; a young or sparse history has little coupling evidence.` }]
        : [...pairsSection(rows, rows.length, guideline, previous), ...judged.map((_, i): Block => ({ type: "judgement", slot: `pair-${i + 1}` })), degreeHistogram(rows)];

    return {
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
        historyWindow: `${evidence.usableHistoryMonths} months of usable history; the analysis window is ${evidence.window.months} months, ${isoDate(extra.window.since)} to ${isoDate(extra.window.until)}${previous === undefined ? "" : `; the previous window for trends is ${isoDate(previous.since)} to ${isoDate(previous.until)}`}`,
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
    };
  },
};

import { contributorsText, type Contributors } from "../contributors.ts";
import { percentText } from "../percent-text.ts";
import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { Block } from "@code-health/report/block";
import type { Cell, RankedTableData } from "@code-health/report/components/ranked-table";
import { dropEmptySlots } from "@code-health/report/empty-block";
import { pageHref, reportHref } from "@code-health/report/links";
import { capRows } from "@code-health/report/table-cap";
import { targetId } from "@code-health/report/text";
import type { Candidate, ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild } from "@code-health/report/report-model";
import { excludedCounts, historyWindowText, isoDate } from "@code-health/history/report-header";
import type { Evidence } from "@code-health/history/evidence";
import type { FiltersApplied } from "@code-health/history/noise";
import { noCacheOption } from "@code-health/history/results-cache";
import { command as hotspotsCommand } from "../commands/hotspots.ts";
import { readSettings } from "../config.ts";
import { orderedHotspots, type HotspotRow } from "../hotspot-ranking.ts";
import { readSiblingResult, type SiblingResult } from "../sibling-reports.ts";
import { windowOptions } from "../window-options.ts";

const TOP = 5;
/** Highlighted files named in the scatter and listed in its table. */
const SCATTER_LABELS = 12;
const FIRST_LOOK_MAX = 3;

/** The fix convention check as hotspots and the other commands print it. */
interface FixConvention {
  fixes: number;
  followsConvention: boolean;
  forms: { conventionalCommits: number; fixVerb: number; issueReference: number };
  landedChanges: number;
  note: string | null;
  share: number;
}

/** The id of a file's row in the table of the highest hotspot scores, which the scatter's named points link to. */
const hotspotRowId = (path: string) => targetId("hotspot", path);

const percent = percentText;
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Commits the history read dropped, and the file changes it dropped, each with the words the page uses. */
const grade = (evidence: Evidence): string => evidence.grade;

function evidenceBlocks(evidence: Evidence, contributors: Contributors): Block[] {
  const g = evidence.guidelines.strong;
  const share = (value: number, guideline: number) => (guideline === 0 ? 0 : (value / guideline) * 100);
  const merge = evidence.commitSize;
  return [
    {
      type: "facts",
      caption: "Evidence behind the history-based results",
      facts: [
        { label: "Evidence grade", value: evidence.grade },
        { label: "Months of usable history", value: String(evidence.usableHistoryMonths) },
        { label: "Active contributors in the window", value: contributorsText(contributors) },
        { label: "Logical changes in the window", value: String(evidence.logicalChangesInWindow) },
        { label: "Shallow clone", value: evidence.truncated.shallow ? `yes, ${evidence.truncated.boundaryCommits} boundary commits` : "no" },
        { label: "Imported history", value: evidence.importedHistory.length === 0 ? "none detected" : `${evidence.importedHistory.length} detected` },
        {
          label: "Merge policy",
          value: merge.shifted
            ? `the median files per change moved from ${merge.earlierMedian} to ${merge.laterMedian}, which usually means a change of merge policy`
            : `no shift in the median files per change (${merge.earlierMedian} earlier, ${merge.laterMedian} later)`,
        },
      ],
    },
    {
      type: "guideline-bars",
      title: "History against the guidelines for strong evidence",
      unit: "percent of the guideline for strong evidence",
      source: `Guidelines for strong evidence: ${g.months} months, ${g.logicalChanges} logical changes, ${g.contributors} contributors.`,
      bars: [
        { label: `Months of history (${evidence.usableHistoryMonths} of ${g.months})`, value: share(evidence.usableHistoryMonths, g.months), guideline: 100 },
        { label: `Logical changes (${evidence.logicalChangesInWindow} of ${g.logicalChanges})`, value: share(evidence.logicalChangesInWindow, g.logicalChanges), guideline: 100 },
        { label: `Contributors (${contributors.people} of ${g.contributors})`, value: share(contributors.people, g.contributors), guideline: 100 },
      ],
    },
    {
      type: "trend-marker",
      label: "Median files per logical change",
      earlier: merge.earlierMedian,
      later: merge.laterMedian,
      windows: ["the earlier half", "the later half"],
      // The same rule as the merge policy line above, so the two never disagree.
      trend: merge.shifted ? (merge.laterMedian > merge.earlierMedian ? "stronger" : "weaker") : "stable",
      wording: { stronger: "more files per change", weaker: "fewer files per change", stable: "no shift" },
    },
  ];
}

function fixBlocks(convention: FixConvention): Block[] {
  return [
    {
      type: "facts",
      caption: "Fix convention check, over the landed changes in the window",
      facts: [
        { label: "Landed changes in the window", value: String(convention.landedChanges) },
        { label: "Changes whose title or message is a fix", value: `${convention.fixes} (${percent(convention.share)})` },
        { label: "Landed changes with a Conventional Commits type (feat, fix, chore and the others, so more than the fixes)", value: String(convention.forms.conventionalCommits) },
        { label: "Landed changes whose title starts with a fix verb", value: String(convention.forms.fixVerb) },
        { label: "Landed changes whose title has a closing keyword and an issue reference", value: String(convention.forms.issueReference) },
        {
          label: "Fix convention used for this repository (decided by whether at least one landed change uses a fix form, not by the share of fixes)",
          value: `${convention.followsConvention ? "yes" : "no"}: Conventional Commits types on ${convention.forms.conventionalCommits}, fix verbs in titles on ${convention.forms.fixVerb}, issue references on ${convention.forms.issueReference} of ${convention.landedChanges} landed changes`,
        },
      ],
    },
    ...(convention.note === null ? [] : [{ type: "notice" as const, level: "notice" as const, text: convention.note }]),
  ];
}

function excludedBlocks(excluded: ExcludedCount[]): Block[] {
  return [
    {
      type: "ranked-table",
      caption: "What the run left out, with counts",
      numbered: false,
      columns: [
        { key: "what", label: "Left out" },
        { key: "count", label: "Count", align: "right" },
      ],
      rows: excluded.map((e): Record<string, Cell> => ({ what: e.what, count: e.count })),
    },
  ];
}

interface Result {
  /** Candidate subject for the first-look slot. */
  candidates: Candidate[];
  blocks: Block[];
  /** What the report read, for the stamp, or null when it did not read a stored result. */
  read: { report: string; head: string; config: string } | null;
  missing: string | null;
}

function missingResult(title: string, command: string): Result {
  return {
    candidates: [],
    blocks: [{ type: "notice", level: "notice", text: `No stored ${title} for this commit. Run \`${command}\` to store it, then run the overview again.` }],
    read: null,
    missing: command,
  };
}

function resultFrom(stored: SiblingResult | undefined, title: string, command: string, build: (stored: SiblingResult) => { block: Block; candidates: Candidate[] }): Result {
  if (stored === undefined) return missingResult(title, command);
  const { block, candidates } = build(stored);
  return { candidates, blocks: [block], read: { report: stored.report, head: stored.head, config: stored.config }, missing: null };
}

/** A ranked table whose rows are the top of a longer result, with the command that prints the rest. */
const topTable = (table: RankedTableData, command: string): Block => ({ type: "ranked-table", ...capRows(table, TOP, command) });

const top = <T>(rows: readonly T[]): T[] => rows.slice(0, TOP);

function complexityResult(stored: SiblingResult | undefined): Result {
  return resultFrom(stored, "complexity analyse result", "complexity analyse", (s) => {
    const rows = top(s.rows);
    return {
      candidates: rows.flatMap((row) => (text(row.id) === null ? [] : [{ ref: `complexity:${text(row.id)}`, label: `${text(row.id)} (complexity)` }])),
      block: topTable({
        caption: "Most complex units, from complexity analyse",
        noun: "units",
        total: s.rows.length,
        emptyText: "The stored complexity analyse result lists no unit.",
        columns: [
          { key: "id", label: "Unit" },
          { key: "cognitive", label: "Cognitive", align: "right" },
          { key: "cyclomatic", label: "Cyclomatic", align: "right" },
          { key: "nesting", label: "Nesting", align: "right" },
          { key: "length", label: "Length", align: "right" },
          { key: "labels", label: "Labels" },
        ],
        rows: rows.map((row): Record<string, Cell> => ({
          id: text(row.id) ?? text(row.path),
          cognitive: number(row.cognitive),
          cyclomatic: number(row.cyclomatic),
          nesting: number(row.nesting),
          length: number(row.length),
          labels: Array.isArray(row.labels) && row.labels.length > 0 ? row.labels.join(", ") : null,
        })),
      }, "complexity analyse"),
    };
  });
}

function cyclesResult(stored: SiblingResult | undefined): Result {
  return resultFrom(stored, "structure cycles result", "structure cycles", (s) => {
    const rows = top(s.rows);
    return {
      candidates: rows.flatMap((row) => (text(row.id) === null ? [] : [{ ref: `structure:${text(row.id)}`, label: `${text(row.id)} (import cycle)` }])),
      block: topTable({
        caption: "Largest import cycles, from structure cycles",
        noun: "cycles",
        total: s.rows.length,
        emptyText: "The stored structure cycles result lists no import cycle.",
        seeAlso: [{ href: reportHref("structure", { id: "cycles" }), text: "The structure report lists the import cycles with their breaking sets." }],
        columns: [
          { key: "id", label: "Cycle" },
          { key: "size", label: "Modules", align: "right" },
          { key: "method", label: "Method" },
          { key: "coChangeAcross", label: "Co-changes across", align: "right" },
          { key: "unblockedGain", label: "Unblocked gain", align: "right" },
        ],
        rows: rows.map((row): Record<string, Cell> => ({
          id: text(row.id),
          size: number(row.size),
          method: text(row.method),
          coChangeAcross: number(row.coChangeAcross),
          unblockedGain: number(row.unblockedGain),
        })),
      }, "structure cycles"),
    };
  });
}

/** The locality kinds with a proposed move or split, whose score is a gain; scrutinise and blocked units are ranked by other measures. */
const MOVE_KINDS = ["move", "review", "split", "inline"];

const LEFT_OUT_LABELS: readonly [string, string][] = [
  ["scrutinise", "to scrutinise for high fan-in"],
  ["blocked", "blocked"],
  ["keep", "to keep"],
];

/**
 * The sentence naming the stored locality units the overview table leaves out, counted by recommendation over
 * the whole stored result: move, review, split and inline units whose gain is 0, then the units that are ranked
 * by other measures. Null when nothing is left out.
 */
export function localityLeftOutNotice(all: readonly Record<string, unknown>[]): string | null {
  const ranking = (row: Record<string, unknown>) => (typeof row.ranking === "object" && row.ranking !== null ? (row.ranking as Record<string, unknown>) : {});
  const gainOf = (row: Record<string, unknown>) => number(ranking(row).value) ?? number(row.score);
  const count = (kind: string, predicate: (row: Record<string, unknown>) => boolean) => all.filter((row) => text(row.recommendation) === kind && predicate(row)).length;
  const parts: string[] = [];
  const zero = MOVE_KINDS.map((kind) => [kind, count(kind, (row) => (gainOf(row) ?? 0) <= 0)] as const).filter(([, n]) => n > 0);
  if (zero.length > 0) {
    const total = zero.reduce((sum, [, n]) => sum + n, 0);
    parts.push(`${total} ${total === 1 ? "unit has" : "units have"} a gain of 0 and ${total === 1 ? "is" : "are"} not listed here: ${zero.map(([kind, n]) => `${n} ${kind}`).join(", ")}.`);
  }
  const other = LEFT_OUT_LABELS.map(([kind, label]) => [label, count(kind, () => true)] as const).filter(([, n]) => n > 0);
  if (other.length > 0) {
    const total = other.reduce((sum, [, n]) => sum + n, 0);
    parts.push(`${total} ${total === 1 ? "unit is" : "units are"} ranked by other measures and not listed here: ${other.map(([label, n]) => `${n} ${label}`).join(", ")}.`);
  }
  if (parts.length === 0) return null;
  return `${parts.join(" ")} \`locality analyse\` and the locality report list them with their own measures.`;
}

function localityResult(stored: SiblingResult | undefined): Result {
  if (stored === undefined) return missingResult("locality analyse result", "locality analyse");
  const ranking = (row: Record<string, unknown>) => (typeof row.ranking === "object" && row.ranking !== null ? (row.ranking as Record<string, unknown>) : {});
  const gainOf = (row: Record<string, unknown>) => number(ranking(row).value) ?? number(row.score);
  const moves = stored.rows.filter((row) => MOVE_KINDS.includes(text(row.recommendation) ?? "") && (gainOf(row) ?? 0) > 0);
  const rows = top(moves);
  const guideline = rows.map((row) => number(ranking(row).guideline)).find((g) => g !== null) ?? undefined;
  const table = topTable({
    caption: "Units with a proposed move, split or inline, by gain, from locality analyse",
    noun: "units",
    total: moves.length,
    emptyText: "The stored locality analyse result lists no unit with a proposed move.",
    seeAlso: [{ href: reportHref("locality", { id: "candidates" }), text: "The locality report lists the candidates with their move plans." }],
    columns: [
      { key: "path", label: "Unit" },
      { key: "recommendation", label: "Recommendation" },
      { key: "gain", label: "Gain", align: "right", ...(guideline === undefined ? {} : { guideline: { value: guideline, note: "locality.minDistance gain guideline" } }) },
      { key: "measure", label: "Gain measure" },
      { key: "distance", label: "Distance", align: "right" },
      { key: "target", label: "Target" },
    ],
    rows: rows.map((row): Record<string, Cell> => ({
      path: text(row.path),
      recommendation: text(row.recommendation),
      gain: gainOf(row),
      measure: text(row.scoreUnit),
      distance: number(row.distance),
      target: text(row.target),
    })),
  }, "locality analyse");
  const blocks: Block[] = [table];
  const notice = localityLeftOutNotice(stored.rows);
  if (notice !== null) blocks.push({ type: "notice", level: "notice", text: notice });
  return {
    candidates: rows.flatMap((row) => (text(row.path) === null ? [] : [{ ref: `locality:${text(row.path)}`, label: `${text(row.path)} (locality)` }])),
    blocks,
    read: { report: stored.report, head: stored.head, config: stored.config },
    missing: null,
  };
}

function hotspotResult(rows: readonly HotspotRow[]): Result {
  const shown = top(rows);
  return {
    candidates: shown.map((row) => ({ ref: `hotspot:${row.path}`, label: `${row.path} (hotspot ranking)` })),
    read: null,
    missing: null,
    blocks: [
      topTable({
        caption: "Highest hotspot scores, from cochange hotspots",
        noun: "files",
        total: rows.length,
        emptyText: "The hotspot ranking lists no file.",
        rowIds: shown.map((row) => hotspotRowId(row.path)),
        seeAlso: [{ href: reportHref("hotspots", { id: "friction" }), text: "The hotspots report draws the map of the code and lists the friction list." }],
        columns: [
          { key: "path", label: "File" },
          { key: "score", label: "Score", align: "right" },
          { key: "frequency", label: "Revisions", align: "right" },
          { key: "complexity", label: "Complexity", align: "right" },
          { key: "fixes", label: "Fixes", align: "right" },
          { key: "recommendation", label: "Flag" },
        ],
        rows: shown.map((row): Record<string, Cell> => ({ path: row.path, score: row.score, frequency: row.frequency, complexity: row.complexity, fixes: row.fixes, recommendation: row.recommendation })),
      }, "cochange hotspots"),
    ],
  };
}


/** The smallest value whose mid-rank percentile among `values` is at or above `percentile`, the line the hotspots friction list draws at that percentile; undefined when no value reaches it. */
function valueAtPercentile(values: readonly number[], percentile: number): number | undefined {
  const ranks = midRankPercentiles(values);
  const reached = values.filter((_, i) => ranks[i]! >= percentile / 100);
  return reached.length === 0 ? undefined : Math.min(...reached);
}

/**
 * Revisions against complexity, one dot per production code file that has a complexity. The lines are the
 * `cochange.hotspotPercentile` of each axis, the same split the hotspots friction list uses for a file when no
 * stored `complexity analyse` result covers the commit. The files in the upper right are highlighted, in the
 * hotspot ranking order, and the top ones are named.
 */
export function scatterBlocks(rows: readonly HotspotRow[], percentile: number, complexitySource: unknown): Block[] {
  const production = rows.filter((row) => row.role !== "test");
  const unmeasured = production.filter((row) => row.complexity === null).length;
  return [
    churnComplexityScatter(rows, percentile, complexitySource),
    {
      type: "paragraph",
      text: `Both lines are at the ${percentile}th percentile (cochange.hotspotPercentile), a rank among the files shown, so they move when files are added. This is the split the hotspots friction list uses when no stored complexity analyse result covers the commit; with one, \`cochange report hotspots\` calls a file complex when it has a function above the cognitive guideline instead, so its list can differ from the upper right here.${unmeasured > 0 ? ` ${unmeasured} of ${production.length} production code files have no complexity and are not drawn.` : ""}`,
    },
  ];
}

function churnComplexityScatter(rows: readonly HotspotRow[], percentile: number, complexitySource: unknown): Block {
  const production = rows.filter((row) => row.role !== "test");
  const measured = production.flatMap((row) => (row.complexity === null ? [] : [{ row, complexity: row.complexity }]));
  const unmeasured = production.length - measured.length;
  const xLine = valueAtPercentile(production.map((row) => row.frequency), percentile);
  const yLine = valueAtPercentile(measured.map((m) => m.complexity), percentile);
  const listed = new Set(top(rows).map((row) => row.path));
  const measure = complexitySource === "complexity-report" ? "the `complexity files` complexity" : "the indentation complexity";
  const points = measured.map(({ row, complexity }) => ({
    label: row.path,
    short: row.path.split("/").at(-1) ?? row.path,
    x: row.frequency,
    y: complexity,
    highlight: xLine !== undefined && yLine !== undefined && row.frequency >= xLine && complexity >= yLine,
    // A file among the highest hotspot scores links to its row in that table.
    ...(listed.has(row.path) ? { href: pageHref(hotspotRowId(row.path)) } : {}),
  }));
  return {
    type: "scatter",
    title: `Revisions against complexity, ${points.length} production code files`,
    xLabel: "Revisions in the window",
    yLabel: "Complexity",
    noun: "files",
    xLog: true,
    yLog: true,
    ...(xLine === undefined ? {} : { xGuideline: { value: xLine, name: `the ${percentile}th percentile of revisions among the ${production.length} files (cochange.hotspotPercentile)` } }),
    ...(yLine === undefined ? {} : { yGuideline: { value: yLine, name: `the ${percentile}th percentile of ${measure} among the ${measured.length} files that have one (cochange.hotspotPercentile)` } }),
    quadrantNames: { upperRight: "changed often and complex (look here first)", upperLeft: "complex, changed less often", lowerRight: "changed often, less complex", lowerLeft: "changed less often and less complex" },
    maxLabels: SCATTER_LABELS,
    points: [...points].sort((a, b) => Number(b.highlight) - Number(a.highlight)),
    emptyText: `No production code file has both revisions and a complexity, so there is no scatter.${unmeasured > 0 ? ` ${unmeasured} files have no complexity.` : ""}`,
  };
}

function slots(candidates: Candidate[]): Slot[] {
  return [
    {
      id: "first-look",
      title: "Judgement: where to start",
      about: { kind: "report", ref: "overview", label: "the repository" },
      task:
        `Choose up to ${FIRST_LOOK_MAX} subjects from the candidates that the tables in this report say are worth a look first, most worthwhile first. For each, give a verdict and one or two sentences of why that cite only values shown in this report. Do not add numbers the report does not show. When the evidence grade is weak, say the history-based results are tentative.`,
      verdicts: ["investigate-first", "worth-a-look", "evidence-too-weak"],
      maxChars: 320,
      choose: { max: FIRST_LOOK_MAX, candidates },
    },
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: { kind: "report", ref: "overview", label: "the repository" },
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the evidence, the exclusions and the missing results shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

function limitsOf(evidence: Evidence, missing: string[], complexitySource: unknown): string[] {
  return [
    "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
    `Each table shows the top ${TOP} of its result and says how many rows it leaves out; the command prints the rest.`,
    ...(evidence.grade === "weak" ? ["The evidence grade is weak, so history-based results are tentative and static signals should lead."] : []),
    ...(evidence.truncated.shallow ? [`The clone is shallow, so history before ${evidence.truncated.availableSince === null ? "its boundary" : isoDate(evidence.truncated.availableSince)} is missing.`] : []),
    ...(evidence.commitSize.shifted ? ["A change of merge policy shifts what a commit means, so compare windows within one policy."] : []),
    ...(complexitySource === "indentation" ? ["Hotspot complexity is the indentation proxy, because no `complexity files` result is stored for this commit."] : []),
    ...(missing.length === 0 ? [] : [`Not stored for this commit: ${missing.join(", ")}. The overview reads other plugins' stored results and never computes them.`]),
  ];
}

export const overview: ReportKind = {
  summary: "Evidence, fix convention, exclusions and the top results of each plugin, with a judgement of what to look at first",
  options: { ...windowOptions, "no-refresh": { type: "boolean" }, ...noCacheOption },
  optionHelp: {
    since: "analyse history from this date (ISO 8601); needed on a shallow clone",
    until: "analyse history up to this date (ISO 8601, exclusive)",
    "no-refresh": "read the history cache without bringing it up to date",
    "no-cache": "compute the hotspot ranking again instead of reading the stored one",
  },
  async build(context: CommandContext): Promise<ReportBuild> {
    const output = await hotspotsCommand.run(context);
    const extra = output.extra as { evidence: Evidence; filtersApplied: FiltersApplied; fixConvention: FixConvention; complexitySource: unknown; window: { since: string; until: string }; contributors?: Contributors };
    const { evidence } = extra;
    const contributors = extra.contributors ?? { people: evidence.activeContributors, agents: 0 };
    const rows = orderedHotspots(output);
    const root = context.repo.root;
    const head = context.repo.head;
    const results = [
      hotspotResult(rows),
      complexityResult(readSiblingResult(root, "complexity", "analyse", head)),
      cyclesResult(readSiblingResult(root, "structure", "cycles", head)),
      localityResult(readSiblingResult(root, "locality", "analyse", head)),
    ];
    const candidates = results.flatMap((r) => r.candidates);
    const missing = results.flatMap((r) => (r.missing === null ? [] : [r.missing]));
    const excluded = excludedCounts(extra.filtersApplied, droppedCounts(), builtinOmissions(), { leftOutOf: "the rankings" });
    const inputs = (output.inputs ?? {}) as Record<string, unknown>;
    return dropEmptySlots({
      title: "Code health overview",
      inputs: {
        since: context.values.since ?? null,
        until: context.values.until ?? null,
        complexityReport: inputs.complexityReport ?? null,
        storedResultsRead: results.flatMap((r) => (r.read === null ? [] : [r.read])),
      },
      header: {
        evidenceGrade: grade(evidence),
        historyWindow: historyWindowText(evidence, extra.window),
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections: [
        { id: "first-look", heading: "What to look at first", blocks: [{ type: "judgement", slot: "first-look" }, ...scatterBlocks(rows, readSettings(context.config).hotspotPercentile, extra.complexitySource)] },
        { id: "evidence", heading: "Evidence", blocks: evidenceBlocks(evidence, contributors) },
        { id: "fix-convention", heading: "Fix convention", blocks: fixBlocks(extra.fixConvention) },
        { id: "excluded", heading: "What was excluded", blocks: excludedBlocks(excluded) },
        { id: "results", heading: "Top results of each plugin", blocks: results.flatMap((r) => r.blocks) },
      ],
      limits: limitsOf(evidence, missing, extra.complexitySource),
      slots: slots(candidates),
    });
  },
};
